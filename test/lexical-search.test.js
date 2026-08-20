import {
  SearchEngine,
  english,
  dictionary,
} from "../src/index.js";
import { analyzeQuery } from "../src/analyze.js";
import { extractFeatures, FEATURE_DEFINITIONS } from "../src/features.js";
import { compareConstraint, constraintCatalog } from "../src/constraints.js";
import { retrieveCandidates } from "../src/retrieve.js";
import { extractVersionCompactForms, queryTokenMatchesVersionCompact } from "../src/versionForms.js";
import { buildIndex } from "../src/indexDocuments.js";
import { scoreFeatures, rankCandidates } from "../src/rank.js";

function engine(docs, dictEntries = []) {
  const e = SearchEngine.create({
    schema: {
      title: { type: "text", role: "title" },
      body: { type: "text", role: "body" },
    },
    plugins: [english(), dictionary({ entries: dictEntries })],
  });
  return e.index(docs).then(() => e);
}

const tlsDict = [
  { key: "tls", expansion: ["transport", "layer", "security"] },
  { key: "oop", expansion: ["object", "oriented", "programming"] },
  { key: "api", expansion: ["application", "programming", "interface"] },
];

describe("version forms", () => {
  test("compact aliases come only from dotted spans", () => {
    expect(extractVersionCompactForms("TLS 1.2 Vulnerability")).toEqual(["12"]);
    expect(extractVersionCompactForms("AES-128 Cipher Suites")).toEqual([]);
    expect(extractVersionCompactForms("Chapter 1 and 2 Overview")).toEqual([]);
    expect(queryTokenMatchesVersionCompact("12", ["12"])).toBe(true);
    expect(queryTokenMatchesVersionCompact("120", ["12"])).toBe(false);
    expect(queryTokenMatchesVersionCompact("128", ["12"])).toBe(false);
  });
});

describe("query analysis", () => {
  test("keeps surface tokens and morphology provenance", () => {
    const q = analyzeQuery("shards", { plugins: [english()] });
    expect(q.tokens[0].surface).toBe("shards");
    expect(q.tokens[0].lemma).toBe("shard");
    expect(q.tokens[0].sources).toContain("morphology");
  });

  test("collapses trailing repeats without dropping the original surface", () => {
    const q = analyzeQuery("shardsss", { plugins: [english()] });
    expect(q.tokens[0].surface).toBe("shardsss");
    expect(q.tokens[0].normalized).toBe("shard");
    expect(q.tokens[0].lemma).toBe("shard");
    expect(q.tokens[0].sources).toContain("repeat-collapse");
    expect(q.tokens[0].sources).toContain("morphology");
  });

  test("maps configured expansions to the same canonical query as the key", () => {
    const plugins = [english(), dictionary({ entries: tlsDict })];
    const expansion = analyzeQuery("transport layer security", { plugins });
    const key = analyzeQuery("tls", { plugins });
    expect(expansion.tokens.map((t) => t.normalized)).toEqual(key.tokens.map((t) => t.normalized));
    expect(expansion.tokens.map((t) => t.lemma)).toEqual(key.tokens.map((t) => t.lemma));
    expect(expansion.concepts.map((c) => `${c.kind}:${c.id}`).sort()).toEqual(
      key.concepts.map((c) => `${c.kind}:${c.id}`).sort()
    );
    expect(expansion.concepts.some((c) => c.kind === "term")).toBe(false);
  });

  test("exact expansion canonicalizes to the key and does not treat one expansion word as the key", () => {
    const gpuDict = [{ key: "gpu", expansion: ["graphics", "processing", "unit"] }];
    const plugins = [english(), dictionary({ entries: gpuDict })];
    const full = analyzeQuery("graphics processing unit", { plugins });
    const keyQ = analyzeQuery("gpu", { plugins });
    expect(full.tokens.map((t) => t.normalized)).toEqual(keyQ.tokens.map((t) => t.normalized));
    expect(full.concepts.some((c) => c.id === "gpu" && c.kind === "acronym")).toBe(true);
    expect(analyzeQuery("graphics", { plugins }).concepts.some((c) => c.id === "gpu")).toBe(false);

    const docs = [
      { id: "gpu-page", title: "GPU", body: "dedicated accelerator" },
      { id: "expansion-page", title: "Graphics Processing Unit", body: "hardware" },
      { id: "graphics-only", title: "Computer Graphics", body: "graphics without the rest" },
      { id: "processing-only", title: "Signal Processing", body: "processing without the rest" },
    ];
    return engine(docs, gpuDict).then((e) => {
      const phrase = e.search("graphics processing unit", { limit: 5, explain: true });
      const expansionHit = phrase.find((r) => r.id === "expansion-page");
      expect(expansionHit).toBeTruthy();
      expect(expansionHit.features.configuredEquivalenceMatch).toBe("expansion");

      const graphics = e.search("graphics", { limit: 5, explain: true });
      const gHit = graphics.find((r) => r.id === "graphics-only");
      expect(gHit).toBeTruthy();
      expect(gHit.features.configuredEquivalenceMatch).not.toBe("expansion");
      expect(gHit.features.configuredEquivalenceMatch).not.toBe("key-in-title");

      const processing = e.search("processing", { limit: 5, explain: true });
      const pHit = processing.find((r) => r.id === "processing-only");
      expect(pHit).toBeTruthy();
      expect(pHit.features.configuredEquivalenceMatch).not.toBe("expansion");

      const key = e.search("gpu", { limit: 5, explain: true });
      const expansionQuery = e.search("graphics processing unit", { limit: 5, explain: true });
      expect(key.map((r) => r.id)).toEqual(expansionQuery.map((r) => r.id));
      const gpuPage = key.find((r) => r.id === "gpu-page");
      expect(gpuPage).toBeTruthy();
      expect(gpuPage.features.configuredEquivalenceMatch).toBe("key-in-title");
    });
  });

  test("http and its exact expansion share one canonical query, candidates, and ranking", async () => {
    const httpDict = [{ key: "http", expansion: ["hypertext", "transfer", "protocol"] }];
    const plugins = [english(), dictionary({ entries: httpDict })];
    const key = analyzeQuery("http", { plugins });
    const expansion = analyzeQuery("hypertext transfer protocol", { plugins });
    expect(key.tokens.map((t) => ({ normalized: t.normalized, lemma: t.lemma }))).toEqual(
      expansion.tokens.map((t) => ({ normalized: t.normalized, lemma: t.lemma }))
    );
    expect(key.concepts.map((c) => ({ id: c.id, kind: c.kind })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      expansion.concepts.map((c) => ({ id: c.id, kind: c.kind })).sort((a, b) => a.id.localeCompare(b.id))
    );
    expect(key.concepts.some((c) => c.kind === "term")).toBe(false);
    expect(expansion.concepts.some((c) => c.kind === "term")).toBe(false);

    const docs = [
      { id: "http", title: "HTTP", body: "status codes and methods" },
      { id: "expansion-title", title: "Hypertext Transfer Protocol", body: "the protocol" },
      { id: "transfer-only", title: "Transfer Rates", body: "transfer transfer transfer" },
      { id: "protocol-only", title: "Network Protocol", body: "a protocol overview" },
    ];
    const index = buildIndex(docs, { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } }, plugins);
    const keyHits = retrieveCandidates(key, index).map((h) => h.document.id).sort();
    const expHits = retrieveCandidates(expansion, index).map((h) => h.document.id).sort();
    expect(expHits).toEqual(keyHits);

    const e = await engine(docs, httpDict);
    expect(e.search("hypertext transfer protocol").map((r) => r.id)).toEqual(e.search("http").map((r) => r.id));
  });

  test("a unique expansion left-prefix is partial-expansion, not the key and not a longer sibling", () => {
    const httpDict = [
      { key: "http", expansion: ["hypertext", "transfer", "protocol"] },
      { key: "https", expansion: ["hypertext", "transfer", "protocol", "secure"] },
      { key: "html", expansion: ["hypertext", "markup", "language"] },
    ];
    const plugins = [english(), dictionary({ entries: httpDict })];
    const prefix = analyzeQuery("hypertext transfer", { plugins });
    expect(prefix.tokens.map((t) => t.normalized)).toEqual(["hypertext", "transfer"]);
    const http = prefix.concepts.filter((c) => c.kind === "acronym");
    expect(http).toHaveLength(1);
    expect(http[0]).toMatchObject({
      id: "http",
      provenance: "partial-expansion",
      matchedExpansionTokens: 2,
      expansionTokenCount: 3,
      expansionCoverage: 0.6667,
    });
    expect(prefix.concepts.some((c) => c.id === "https")).toBe(false);
    expect(prefix.concepts.some((c) => c.kind === "term")).toBe(false);

    const lone = analyzeQuery("hypertext", { plugins });
    expect(lone.concepts.some((c) => c.kind === "acronym")).toBe(false);
    expect(lone.concepts.some((c) => c.kind === "term" && c.forms.includes("hypertext"))).toBe(true);

    expect(analyzeQuery("transfer", { plugins }).concepts.some((c) => c.kind === "acronym")).toBe(false);
  });

  test("completing a unique expansion prefix stays HTTP-like and does not collapse until exact", async () => {
    const httpDict = [
      { key: "http", expansion: ["hypertext", "transfer", "protocol"] },
      { key: "https", expansion: ["hypertext", "transfer", "protocol", "secure"] },
    ];
    const plugins = [english(), dictionary({ entries: httpDict })];
    const docs = [
      { id: "http-title", title: "HTTP", body: "methods and status codes" },
      { id: "http-body", title: "Request Response", body: "http methods and status codes" },
      { id: "tls", title: "TLS 1.2 Vulnerability", body: "hypertext mention in a tls article" },
      { id: "transfer-only", title: "Transfer Rates", body: "transfer transfer transfer" },
    ];
    const e = await engine(docs, httpDict);
    const ranked = [
      "hypertext transfer",
      "hypertext transfer p",
      "hypertext transfer pro",
      "hypertext transfer protocol",
    ].map((raw) => {
      const q = analyzeQuery(raw, { plugins });
      const acr = q.concepts.find((c) => c.kind === "acronym");
      return {
        raw,
        tokens: q.tokens.map((t) => t.normalized),
        key: acr?.id,
        kind: acr?.provenance,
        ids: e.search(raw).map((r) => r.id),
      };
    });
    for (const row of ranked) {
      expect(row.key).toBe("http");
    }
    expect(ranked[0].kind).toBe("partial-expansion");
    expect(ranked[3].kind).toBe("expansion");
    expect(ranked[3].tokens).toEqual(["hypertext", "transfer", "protocol"]);
    expect(ranked[0].tokens).toEqual(["hypertext", "transfer"]);
    const httpIds = e.search("http").map((r) => r.id);
    expect(ranked[3].ids).toEqual(httpIds);
    for (const row of ranked) {
      expect(row.ids[0]).toBe("http-title");
      expect(row.ids).toContain("http-body");
      const tlsAt = row.ids.indexOf("tls");
      if (tlsAt >= 0) expect(row.ids.indexOf("http-body")).toBeLessThan(tlsAt);
    }
    expect(analyzeQuery("http", { plugins }).tokens.map((t) => t.normalized)).toEqual(
      analyzeQuery("hypertext transfer protocol", { plugins }).tokens.map((t) => t.normalized)
    );
  });

  test("ambiguous shared expansion prefixes are not attached", () => {
    const plugins = [
      english(),
      dictionary({
        entries: [
          { key: "sla", expansion: ["service", "level", "agreement"] },
          { key: "slo", expansion: ["service", "level", "objective"] },
          { key: "sli", expansion: ["service", "level", "indicator"] },
          { key: "vpn", expansion: ["virtual", "private", "network"] },
          { key: "vpc", expansion: ["virtual", "private", "cloud"] },
          { key: "graphql", expansion: ["graph", "query", "language"] },
          { key: "gql", expansion: ["graph", "query", "language"] },
          { key: "url", expansion: ["uniform", "resource", "locator"] },
          { key: "uri", expansion: ["uniform", "resource", "identifier"] },
          { key: "ecs", expansion: ["elastic", "container", "service"] },
          { key: "ecr", expansion: ["elastic", "container", "registry"] },
        ],
      }),
    ];
    for (const raw of ["service level", "virtual private", "graph query", "uniform resource", "elastic container"]) {
      const q = analyzeQuery(raw, { plugins });
      expect(q.concepts.some((c) => c.kind === "acronym")).toBe(false);
    }
  });

  test("unique three-token expansion prefixes attach the shorter winner", () => {
    const plugins = [
      english(),
      dictionary({
        entries: [
          { key: "http", expansion: ["hypertext", "transfer", "protocol"] },
          { key: "https", expansion: ["hypertext", "transfer", "protocol", "secure"] },
          { key: "api", expansion: ["application", "programming", "interface"] },
          { key: "oop", expansion: ["object", "oriented", "programming"] },
          { key: "tls", expansion: ["transport", "layer", "security"] },
          { key: "dfs", expansion: ["depth", "first", "search"] },
        ],
      }),
    ];
    const expected = [
      ["hypertext transfer", "http"],
      ["application programming", "api"],
      ["object oriented", "oop"],
      ["transport layer", "tls"],
      ["depth first", "dfs"],
    ];
    for (const [raw, key] of expected) {
      const q = analyzeQuery(raw, { plugins });
      const acr = q.concepts.filter((c) => c.kind === "acronym");
      expect(acr).toHaveLength(1);
      expect(acr[0].id).toBe(key);
      expect(acr[0].provenance).toBe("partial-expansion");
      expect(acr[0].matchedExpansionTokens).toBe(2);
      expect(acr[0].expansionTokenCount).toBe(3);
      expect(acr[0].expansionCoverage).toBe(0.6667);
      expect(q.tokens).toHaveLength(2);
    }
    expect(analyzeQuery("hypertext", { plugins }).concepts.some((c) => c.kind === "acronym")).toBe(false);
    const full = analyzeQuery("hypertext transfer protocol", { plugins });
    expect(full.tokens.map((t) => t.normalized)).toEqual(["hypertext", "transfer", "protocol"]);
    expect(full.concepts.find((c) => c.kind === "acronym")?.provenance).toBe("expansion");
  });

  test("incomplete key prefixes match only the final active token", () => {
    const plugins = [
      english(),
      dictionary({
        entries: [
          { key: "graphql", expansion: ["graph", "query", "language"] },
          { key: "gql", expansion: ["graph", "query", "language"] },
          { key: "jwt", expansion: ["json", "web", "token"] },
          { key: "webrtc", expansion: ["web", "real", "time", "communication"] },
          { key: "reactjs", expansion: ["react", "js"] },
          { key: "rsc", expansion: ["react", "server", "components"] },
          { key: "tls", expansion: ["transport", "layer", "security"] },
        ],
      }),
    ];
    expect(analyzeQuery("graph query", { plugins }).concepts.some((c) => c.id === "graphql")).toBe(false);
    expect(analyzeQuery("web development", { plugins }).concepts.some((c) => c.id === "webrtc")).toBe(false);
    const authGraphq = analyzeQuery("auth graphq", { plugins }).concepts.filter((c) => c.kind === "acronym");
    expect(authGraphq.some((c) => c.id === "graphql")).toBe(true);
    const whatIsGraphq = analyzeQuery("what is graphq", { plugins }).concepts.filter((c) => c.kind === "acronym");
    expect(whatIsGraphq.some((c) => c.id === "graphql")).toBe(true);
    const standalone = analyzeQuery("graphq", { plugins }).concepts.filter((c) => c.kind === "acronym");
    expect(standalone).toHaveLength(1);
    expect(standalone[0].id).toBe("graphql");
    const exactMiddle = analyzeQuery("use graphql today", { plugins }).concepts.filter((c) => c.kind === "acronym");
    expect(exactMiddle.some((c) => c.id === "graphql" && c.provenance === "key")).toBe(true);
    const exactFirst = analyzeQuery("tls handshake", { plugins }).concepts.filter((c) => c.kind === "acronym");
    expect(exactFirst.some((c) => c.id === "tls" && c.provenance === "key")).toBe(true);
    const jwt = analyzeQuery("json web", { plugins }).concepts.filter((c) => c.kind === "acronym");
    expect(jwt).toHaveLength(1);
    expect(jwt[0].id).toBe("jwt");
    expect(jwt[0].provenance).toBe("partial-expansion");
    expect(analyzeQuery("react", { plugins }).concepts.some((c) => c.id === "reactjs")).toBe(true);
    const rsc = analyzeQuery("react server", { plugins }).concepts.filter((c) => c.kind === "acronym");
    expect(rsc).toHaveLength(1);
    expect(rsc[0].id).toBe("rsc");
    expect(rsc[0].provenance).toBe("partial-expansion");
  });

  test("ambiguous configured-key prefixes are order-independent and stay unattached", () => {
    const forward = [
      { key: "reactjs", expansion: ["react", "js"] },
      { key: "reactnative", expansion: ["react", "native"] },
    ];
    const reverse = [...forward].reverse();
    for (const entries of [forward, reverse]) {
      const plugins = [english(), dictionary({ entries })];
      expect(analyzeQuery("react", { plugins }).concepts.some((c) => c.kind === "acronym")).toBe(false);
      const exact = analyzeQuery("reactjs", { plugins }).concepts.filter((c) => c.kind === "acronym");
      expect(exact).toHaveLength(1);
      expect(exact[0].id).toBe("reactjs");
      expect(exact[0].provenance).toBe("key");
    }
    const unique = analyzeQuery("react", {
      plugins: [english(), dictionary({ entries: [forward[0]] })],
    }).concepts.filter((c) => c.kind === "acronym");
    expect(unique).toHaveLength(1);
    expect(unique[0].id).toBe("reactjs");
  });

  test("shared exact expansions do not collapse when more than one key owns them", () => {
    const forward = [
      { key: "graphql", expansion: ["graph", "query", "language"] },
      { key: "gql", expansion: ["graph", "query", "language"] },
    ];
    const reverse = [...forward].reverse();
    for (const entries of [forward, reverse]) {
      const plugins = [english(), dictionary({ entries })];
      const q = analyzeQuery("graph query language", { plugins });
      expect(q.tokens.map((t) => t.normalized)).toEqual(["graph", "query", "language"]);
      expect(q.concepts.some((c) => c.kind === "acronym")).toBe(false);
      expect(analyzeQuery("graphql", { plugins }).tokens.map((t) => t.normalized)).toEqual(["graphql"]);
      expect(analyzeQuery("gql", { plugins }).tokens.map((t) => t.normalized)).toEqual(["gql"]);
    }
    const withPrimaryHint = [
      { key: "graphql", expansion: ["graph", "query", "language"], primary: "graph" },
      { key: "gql", expansion: ["graph", "query", "language"], primary: "graphql" },
    ];
    for (const entries of [withPrimaryHint, [...withPrimaryHint].reverse()]) {
      const q = analyzeQuery("graph query language", {
        plugins: [english(), dictionary({ entries })],
      });
      expect(q.tokens.map((t) => t.normalized)).toEqual(["graph", "query", "language"]);
      expect(q.concepts.some((c) => c.kind === "acronym")).toBe(false);
    }
  });

  test("unique learn* prefixes share canonical tokens, candidates, and ranked IDs", async () => {
    const mlDict = [{ key: "ml", expansion: ["machine", "learning"] }];
    const plugins = [english(), dictionary({ entries: mlDict })];
    const lexicon = ["machine", "learn", "learning", "learnings", "application", "security"];
    const incomplete = ["machine learn", "machine learni", "machine learnin"];
    const analyzed = incomplete.map((raw) => analyzeQuery(raw, { plugins, lexicon, prefixLexicon: lexicon }));
    const canonical = analyzed.map((q) => q.tokens.map((t) => ({ normalized: t.normalized, lemma: t.lemma })));
    for (const shape of canonical) {
      expect(shape).toEqual([
        { normalized: "machine", lemma: "machine" },
        { normalized: "learn", lemma: "learn" },
      ]);
    }
    const conceptShape = analyzed[0].concepts.map((c) => `${c.kind}:${c.id}`).sort();
    for (const q of analyzed) {
      expect(q.concepts.map((c) => `${c.kind}:${c.id}`).sort()).toEqual(conceptShape);
    }
    expect(analyzed[1].tokens[1].surface).toBe("learni");
    expect(analyzed[1].tokens[1].surfaceNormalized).toBe("learni");
    expect(analyzed[1].tokens[1].completedToken).toBe("learning");
    expect(analyzed[1].prefixCompletion.ambiguous).toBe(false);
    expect(analyzed[2].tokens[1].surface).toBe("learnin");

    const full = analyzeQuery("machine learning", { plugins, lexicon, prefixLexicon: lexicon });
    const key = analyzeQuery("ml", { plugins, lexicon, prefixLexicon: lexicon });
    expect(full.tokens.map((t) => t.normalized)).toEqual(key.tokens.map((t) => t.normalized));
    expect(full.tokens.map((t) => t.normalized)).toEqual(["machine", "learn"]);
    expect(full.concepts.find((c) => c.kind === "acronym")?.provenance).toBe("expansion");
    expect(key.concepts.find((c) => c.kind === "acronym")?.provenance).toBe("key");

    const docs = [
      {
        id: "linear",
        title: "Linear vs Logistic Regression",
        body: "machine learning machine learning machine learning machine learning machine learning",
        lexicalFrequency: { "machine learn": 5, machine: 5, learn: 5 },
      },
      { id: "linkedin", title: "LinkedIn Learning Review", body: "courses" },
      { id: "appsec", title: "App Sec", body: "application security practices" },
      { id: "learn-code", title: "Why Learn to Code?", body: "learn" },
    ];
    const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
    const index = buildIndex(docs, schema, plugins);
    const candidateSets = analyzed.map((q) => retrieveCandidates(q, index).map((h) => h.document.id).sort());
    for (const ids of candidateSets) expect(ids).toEqual(candidateSets[0]);

    const e = await engine(docs, mlDict);
    const ranked = incomplete.map((raw) => e.search(raw).map((r) => r.id));
    for (const ids of ranked) expect(ids).toEqual(ranked[0]);
    expect(analyzeQuery("machine learning", { plugins, lexicon, prefixLexicon: lexicon }).tokens.map((t) => t.normalized)).toEqual(
      ["machine", "learn"]
    );
  });

  test("exact expansion collapse keeps pre-collapse lexical phrase evidence", async () => {
    const mlDict = [{ key: "ml", expansion: ["machine", "learning"] }];
    const plugins = [english(), dictionary({ entries: mlDict })];
    const lexicon = ["machine", "learn", "learning", "learnings"];
    const docs = [
      {
        id: "linear",
        title: "Linear vs Logistic Regression",
        body: "machine learning machine learning machine learning machine learning machine learning",
        lexicalFrequency: { "machine learn": 5, machine: 5, learn: 5 },
      },
      { id: "linkedin", title: "LinkedIn Learning Review", body: "courses" },
    ];
    const e = await engine(docs, mlDict);
    const full = analyzeQuery("machine learning", { plugins, lexicon, prefixLexicon: lexicon });
    expect(full.tokens.map((t) => t.normalized)).toEqual(["machine", "learn"]);
    expect(full.concepts.find((c) => c.kind === "acronym")).toMatchObject({
      id: "ml",
      provenance: "expansion",
    });
    expect(full.lexicalPhraseKey).toBe("machine learn");
    expect(full.lexicalPhraseTokens).toEqual(["machine", "learn"]);
    expect(full.lexicalTokens).toHaveLength(2);

    const linear = e.searchDetailed("machine learning", { limit: 5, explain: true }).results.find(
      (r) => r.title === "Linear vs Logistic Regression"
    );
    expect(linear.features.matchingPhraseKey).toBe("machine learn");
    expect(linear.features.normalizedQueryPhrase).toBe("machine learn");
    expect(linear.features.bodyPhraseCount).toBe(5);
    expect(linear.features.queryTokenCount).toBe(2);

    const chain = ["machine learn", "machine learni", "machine learnin", "machine learning"];
    const phraseRows = chain.map((raw) => {
      const detailed = e.searchDetailed(raw, { limit: 5, explain: true });
      const row = detailed.results.find((r) => r.id === "linear");
      return {
        raw,
        ids: detailed.results.map((r) => r.id),
        rank: row.rank,
        bodyPhraseCount: row.features.bodyPhraseCount,
        matchingPhraseKey: row.features.matchingPhraseKey,
        queryTokenCount: row.features.queryTokenCount,
      };
    });
    for (const row of phraseRows) {
      expect(row.bodyPhraseCount).toBe(5);
      expect(row.matchingPhraseKey).toBe("machine learn");
      expect(row.queryTokenCount).toBe(2);
      expect(row.rank).toBe(1);
    }
  });

  test("unique configured-equivalence forms share canonical intent and ranked IDs", async () => {
    const mlDict = [{ key: "ml", expansion: ["machine", "learning"] }];
    const plugins = [english(), dictionary({ entries: mlDict })];
    const lexicon = ["machine", "learn", "learning", "learnings", "notes"];
    const forms = ["ml", "machine learning", "machine learn"];
    const analyzed = Object.fromEntries(
      forms.map((raw) => [raw, analyzeQuery(raw, { plugins, lexicon, prefixLexicon: lexicon })])
    );

    expect(analyzed.ml.concepts.find((c) => c.kind === "acronym")).toMatchObject({
      id: "ml",
      provenance: "key",
    });
    expect(analyzed["machine learning"].concepts.find((c) => c.kind === "acronym")).toMatchObject({
      id: "ml",
      provenance: "expansion",
    });
    expect(analyzed["machine learn"].concepts.find((c) => c.kind === "acronym")).toMatchObject({
      id: "ml",
      provenance: "partial-expansion",
    });

    const intent = ["machine", "learn"];
    for (const raw of forms) {
      expect(analyzed[raw].tokens.map((t) => t.normalized)).toEqual(intent);
      expect(analyzed[raw].lexicalPhraseTokens).toEqual(intent);
      expect(analyzed[raw].lexicalPhraseKey).toBe("machine learn");
    }

    const docs = [
      {
        id: "strong-phrase",
        title: "Phrase Heavy Guide",
        body: "machine learning machine learning machine learning machine learning machine learning",
        lexicalFrequency: { "machine learn": 5, machine: 5, learn: 5 },
      },
      { id: "learn-only", title: "Learn Notes", body: "learn without the first expansion word" },
      { id: "key-only", title: "ML Notes", body: "ml ml ml without the expansion phrase" },
      { id: "machine-only", title: "Machine Shop", body: "machine without learn" },
      { id: "weak-incidental", title: "Unrelated Overview", body: "security notes" },
    ];
    const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };
    const index = buildIndex(docs, schema, plugins);
    const candidateSets = forms.map((raw) =>
      retrieveCandidates(analyzed[raw], index)
        .map((h) => h.document.id)
        .sort()
    );
    expect(candidateSets[0]).toEqual(candidateSets[1]);
    expect(candidateSets[1]).toEqual(candidateSets[2]);

    const e = await engine(docs, mlDict);
    const ranked = forms.map((raw) => e.search(raw).map((r) => r.id));
    expect(ranked[0]).toEqual(ranked[1]);
    expect(ranked[1]).toEqual(ranked[2]);
    expect(ranked[0]).toEqual(
      expect.arrayContaining(["strong-phrase", "learn-only", "key-only", "machine-only"])
    );
    expect(ranked[0]).not.toContain("weak-incidental");
  });

  test("ambiguous prefixes are not canonicalized", () => {
    const q = analyzeQuery("open inter", {
      plugins: [english()],
      lexicon: ["open", "interface", "interceptor", "internet"],
      prefixLexicon: ["open", "interface", "interceptor", "internet"],
    });
    expect(q.prefixCompletion.ambiguous).toBe(true);
    expect(q.tokens[1].normalized).toBe("inter");
    expect(q.tokens[1].lemma).toBe("inter");
    expect(q.tokens[1].completedToken).toBeUndefined();
  });

  test("single-letter queries do not prefix-match dictionary keys", () => {
    const q = analyzeQuery("a", {
      plugins: [english(), dictionary({ entries: tlsDict })],
    });
    expect(q.concepts.some((c) => c.kind === "acronym")).toBe(false);
  });
});

describe("exact title and coverage", () => {
  const docs = [
    { id: "/object/", title: "Object", body: "Object in programming." },
    {
      id: "/oop/",
      title: "What is OOP (Object-Oriented Programming)?",
      body: "Object-oriented programming is about objects.",
    },
    {
      id: "/rate-limiting/",
      title: "Rate Limiting",
      body: "Rate limiting is a technique.",
    },
    {
      id: "/rate-limiting-algorithms/",
      title: "Rate Limiting Algorithms",
      body: "Rate limiting algorithms include token bucket. Rate limiting is common.",
    },
  ];

  test("exact title Object outranks a longer title that contains the token", async () => {
    const e = await engine(docs, tlsDict);
    const results = e.search("object", { limit: 5, explain: true });
    expect(results[0].title).toBe("Object");
    expect(results[0].features.exactTitleMatch).toBe(true);
    expect(results[0].retrievalSources).toContain("exact-title");
  });

  test("exact title Rate Limiting outranks a longer title with the phrase in the body", async () => {
    const e = await engine(docs, tlsDict);
    const results = e.search("rate limiting", { limit: 5, explain: true });
    expect(results[0].title).toBe("Rate Limiting");
    expect(results[0].features.exactTitleMatch).toBe(true);
  });

  test("prefix rate limit still prefers the tighter title", async () => {
    const e = await engine(docs, tlsDict);
    const results = e.search("rate limit", { limit: 5, explain: true });
    expect(results[0].title).toBe("Rate Limiting");
  });
});

describe("morphology vs surface", () => {
  const docs = [
    { id: "/sharding/", title: "Sharding", body: "Sharding is partitioning." },
    {
      id: "/hot-shards/",
      title: "Hot Shards",
      body: "Hot shards happen when a subset of shards receive traffic.",
    },
  ];

  test("shards and sharding share the shard lemma so both titles retrieve", async () => {
    const e = await engine(docs);
    const q = analyzeQuery("shards", { plugins: [english()] });
    expect(q.tokens[0]).toMatchObject({ surface: "shards", surfaceNormalized: "shards", normalized: "shard", lemma: "shard" });
    const results = e.search("shards", { limit: 5 });
    expect(results.map((r) => r.title).sort()).toEqual(["Hot Shards", "Sharding"]);
  });

  test("typed shards prefers Hot Shards over lemma-only Sharding", async () => {
    const e = await engine(docs);
    const results = e.search("shards", { limit: 5, explain: true });
    expect(results[0].title).toBe("Hot Shards");
    expect(results[1].title).toBe("Sharding");
    expect(results[0].features.typedSurfaceTitleMatch).toBe(true);
    expect(results[1].features.typedSurfaceTitleMatch).toBe(false);
  });

  test("trailing-repeat shardsss ranks identically to shards", async () => {
    const e = await engine(docs);
    expect(e.search("shardsss").map((r) => r.id)).toEqual(e.search("shards").map((r) => r.id));
  });
});

describe("version compact", () => {
  const docs = [
    {
      id: "/tls/",
      title: "TLS 1.2 Vulnerability",
      body: "TLS 1.2 protocol vulnerability and AES-128 cipher suites.",
    },
    { id: "/saml/", title: "SAML vs OAuth", body: "SAML and OAuth authorization." },
    { id: "/zts/", title: "Zero-Trust Security", body: "Zero trust security architecture." },
    {
      id: "/d3d/",
      title: "Direct3D 12 Guide",
      body: "A guide to Direct3D 12.",
    },
    { id: "/aes/", title: "AES-128 Cipher Suites", body: "AES-128 GCM cipher suites." },
    { id: "/ch/", title: "Chapter 1 and 2 Overview", body: "Chapter 1 and chapter 2 are separate." },
  ];

  test("12 vulnerability ranks TLS first", async () => {
    const e = await engine(docs, tlsDict);
    expect(e.search("12 vulnerability")[0].title).toBe("TLS 1.2 Vulnerability");
  });

  test("tls 12 ranks TLS first", async () => {
    const e = await engine(docs, tlsDict);
    expect(e.search("tls 12")[0].title).toBe("TLS 1.2 Vulnerability");
  });

  test("120 does not alias compact 12", async () => {
    const e = await engine(docs, tlsDict);
    const titles = e.search("120", { limit: 10 }).map((r) => r.title);
    expect(titles).not.toContain("TLS 1.2 Vulnerability");
  });

  test("literal 12 outranks compact 1.2", async () => {
    const e = await engine(docs, tlsDict);
    const results = e.search("12", { limit: 5 });
    expect(results[0].title).toBe("Direct3D 12 Guide");
  });

  test("AES-128 hyphen is not a 1.2 alias", async () => {
    const e = await engine(docs, tlsDict);
    const results = e.search("12", { limit: 5 });
    expect(results[0].title).not.toBe("AES-128 Cipher Suites");
    expect(results.map((r) => r.title)).not.toContain("AES-128 Cipher Suites");
  });

  test("128 ranks AES and does not alias compact 12", async () => {
    const e = await engine(docs, tlsDict);
    const results = e.search("128", { limit: 5, explain: true });
    expect(results[0].title).toBe("AES-128 Cipher Suites");
    const tls = results.find((r) => r.title === "TLS 1.2 Vulnerability");
    if (tls) {
      expect(tls.retrievalSources).not.toContain("version");
      expect(tls.features.versionMatch).toBe(false);
    }
  });

  test("near-complete companion 12 vulnerab still ranks TLS", async () => {
    const e = await engine(docs, tlsDict);
    expect(e.search("12 vulnerab")[0].title).toBe("TLS 1.2 Vulnerability");
  });
});

describe("short literal lead", () => {
  test("s3 prefers the lead token title", async () => {
    const e = await engine([
      { id: "/s3/", title: "S3 Bucket Policies", body: "Access policies for S3 buckets." },
      { id: "/iam/", title: "IAM Access For S3", body: "Granting IAM roles access for S3." },
    ]);
    const results = e.search("s3");
    expect(results[0].title).toBe("S3 Bucket Policies");
  });

  test("query a does not promote a non-leading API title over Agile", async () => {
    const e = await engine([
      { id: "/agile/", title: "Agile vs Waterfall", body: "Agile versus waterfall." },
      { id: "/api/", title: "What is an API?", body: "An API is an application programming interface." },
      { id: "/object/", title: "Object", body: "Object in programming." },
    ]);
    const results = e.search("a");
    expect(results[0].title).toBe("Agile vs Waterfall");
  });
});

describe("configured equivalence and explanations", () => {
  test("expansion query retrieves the acronym title and explains sources", async () => {
    const e = await engine(
      [
        {
          id: "/tls/",
          title: "TLS 1.2 Vulnerability",
          body: "Transport layer security and TLS 1.2.",
        },
        { id: "/vpn/", title: "What is VPN?", body: "Virtual private network." },
      ],
      tlsDict
    );
    const results = e.search("transport layer security", { limit: 5, explain: true });
    expect(results[0].title).toBe("TLS 1.2 Vulnerability");
    expect(results[0].retrievalSources.length).toBeGreaterThan(0);
    expect(results[0].explanation.query.concepts.some((c) => c.id === "tls")).toBe(true);
    expect(results[0].features).toHaveProperty("queryCoverage");
  });
});

describe("constraints vs score", () => {
  test("exact title constraint fires without giant constants", () => {
    const a = {
      document: { id: "a" },
      features: {
        exactTitleMatch: true,
        queryCoverage: 1,
        titleCoverage: 1,
        titlePrefixQuality: 1,
        exactTitleTokenMatch: true,
        configuredEquivalenceMatch: false,
        morphologyMatch: false,
        typoDistance: 0,
        versionMatch: false,
        shortLiteralLeadMatch: false,
        phraseAdjacency: 0,
        bodyLexicalMatch: 0,
        titleTokenCount: 1,
      },
    };
    const b = {
      document: { id: "b" },
      features: {
        exactTitleMatch: false,
        queryCoverage: 0.5,
        titleCoverage: 0.2,
        titlePrefixQuality: 0.2,
        exactTitleTokenMatch: true,
        configuredEquivalenceMatch: false,
        morphologyMatch: false,
        typoDistance: 0,
        versionMatch: false,
        shortLiteralLeadMatch: false,
        phraseAdjacency: 1,
        bodyLexicalMatch: 1,
        titleTokenCount: 6,
      },
    };
    expect(compareConstraint(a, b).order).toBe(-1);
    expect(scoreFeatures(a.features)).toBeLessThan(20);
  });
});

describe("candidate provenance", () => {
  test("body matcher can retrieve a title-miss as body-lexical", () => {
    const index = buildIndex(
      [
        {
          id: "/hidden/",
          title: "Unrelated Title",
          body: "this body mentions protobuf encoding extensively",
        },
      ],
      { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
      [english()]
    );
    const query = analyzeQuery("protobuf", { plugins: [english()] });
    const hits = retrieveCandidates(query, index);
    expect(hits[0].retrievalSources).toContain("body-lexical");
  });
});

describe("features ranking and explanations", () => {
  test("extractFeatures emits the documented named set", () => {
    const index = buildIndex(
      [{ id: "/object/", title: "Object", body: "An object." }],
      { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
      [english()]
    );
    const query = analyzeQuery("object", { plugins: [english()] });
    const features = extractFeatures(query, index.documents[0]);
    expect(features.exactTitleMatch).toBe(true);
    expect(Object.keys(FEATURE_DEFINITIONS).sort()).toEqual(Object.keys(features).sort());
  });

  test("constraint catalog is explicit and non-empty", () => {
    const catalog = constraintCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(6);
    expect(catalog.every((c) => c.id && c.invariant)).toBe(true);
  });

  test("ranking tie-break is stable document id", () => {
    const blank = {
      exactTitleMatch: false,
      exactTitleTokenMatch: false,
      titleCoverage: 0,
      queryCoverage: 0,
      titlePrefixQuality: 0,
      configuredEquivalenceMatch: false,
      morphologyMatch: false,
      typoDistance: 0,
      versionMatch: false,
      shortLiteralLeadMatch: false,
      phraseAdjacency: 0,
      bodyLexicalMatch: 0,
      titleTokenCount: 1,
    };
    const ranked = rankCandidates([
      { document: { id: "b" }, features: { ...blank }, retrievalSources: ["body-lexical"] },
      { document: { id: "a" }, features: { ...blank }, retrievalSources: ["body-lexical"] },
    ]);
    expect(ranked[0].document.id).toBe("a");
    expect(ranked[1].document.id).toBe("b");
  });

  test("dotted query spans are kept on the raw query not token join", () => {
    const q = analyzeQuery("1.2 vulnerability", { plugins: [english()] });
    expect(q.dottedSpans).toContain("1.2");
    expect(q.tokens.map((t) => t.normalized)).toEqual(["1", "2", "vulnerability"]);
  });
});
