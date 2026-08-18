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

describe("search-v2 version forms", () => {
  test("compact aliases come only from dotted spans", () => {
    expect(extractVersionCompactForms("TLS 1.2 Vulnerability")).toEqual(["12"]);
    expect(extractVersionCompactForms("AES-128 Cipher Suites")).toEqual([]);
    expect(extractVersionCompactForms("Chapter 1 and 2 Overview")).toEqual([]);
    expect(queryTokenMatchesVersionCompact("12", ["12"])).toBe(true);
    expect(queryTokenMatchesVersionCompact("120", ["12"])).toBe(false);
    expect(queryTokenMatchesVersionCompact("128", ["12"])).toBe(false);
  });
});

describe("search-v2 query analysis", () => {
  test("keeps surface tokens and morphology provenance", () => {
    const q = analyzeQuery("shards", { plugins: [english()] });
    expect(q.tokens[0].surface).toBe("shards");
    expect(q.tokens[0].lemma).toBe("shard");
    expect(q.tokens[0].sources).toContain("morphology");
  });

  test("collapses trailing repeats without dropping the original surface", () => {
    const q = analyzeQuery("shardsss", { plugins: [english()] });
    expect(q.tokens[0].surface).toBe("shardsss");
    expect(q.tokens[0].normalized).toBe("shards");
    expect(q.tokens[0].sources).toContain("repeat-collapse");
  });

  test("maps configured expansions to one acronym concept", () => {
    const q = analyzeQuery("transport layer security", {
      plugins: [english(), dictionary({ entries: tlsDict })],
    });
    expect(q.concepts.some((c) => c.id === "tls" && c.kind === "acronym")).toBe(true);
  });

  test("single-letter queries do not prefix-match dictionary keys", () => {
    const q = analyzeQuery("a", {
      plugins: [english(), dictionary({ entries: tlsDict })],
    });
    expect(q.concepts.some((c) => c.kind === "acronym")).toBe(false);
  });
});

describe("search-v2 exact title and coverage", () => {
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

describe("search-v2 morphology vs surface", () => {
  const docs = [
    { id: "/sharding/", title: "Sharding", body: "Sharding is partitioning." },
    {
      id: "/hot-shards/",
      title: "Hot Shards",
      body: "Hot shards happen when a subset of shards receive traffic.",
    },
  ];

  test("shards prefers Hot Shards over Sharding", async () => {
    const e = await engine(docs);
    const results = e.search("shards", { limit: 5, explain: true });
    expect(results[0].title).toBe("Hot Shards");
    expect(results[0].features.exactTitleTokenMatch).toBe(true);
  });

  test("trailing-repeat shardsss still prefers Hot Shards", async () => {
    const e = await engine(docs);
    const results = e.search("shardsss", { limit: 5 });
    expect(results[0].title).toBe("Hot Shards");
  });
});

describe("search-v2 version compact", () => {
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

describe("search-v2 short literal lead", () => {
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

describe("search-v2 configured equivalence and explanations", () => {
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

describe("search-v2 constraints vs score", () => {
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

describe("search-v2 candidate provenance", () => {
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

describe("search-v2 features ranking and explanations", () => {
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
