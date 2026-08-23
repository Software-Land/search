import { analyzeQuery } from "../dist/analyze.js";
import { morphology, dictionary, SearchEngine } from "../dist/index.js";
import { extractFeatures } from "../dist/features.js";
import { compoundSpellSegment, MAX_COMPOUND_REPAIR_TOKEN_LENGTH } from "../dist/analyzeRepair.js";
import { conceptMatchesBody, conceptMatchesTitle } from "../dist/retrieve.js";
import { buildIndex } from "../dist/indexDocuments.js";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

describe("exact compound segmentation", () => {
  const appsecDict = [
    {
      key: "appsec",
      expansion: ["application", "security"],
      aliases: [
        ["app", "sec"],
        ["app", "security"],
      ],
    },
  ];

  test("appsecurity splits to app + security", () => {
    const q = analyzeQuery("appsecurity", {
      plugins: [morphology(), dictionary({ entries: appsecDict })],
    });
    expect(q.tokens.map((t) => t.normalized)).toEqual(["app", "security"]);
  });

  test("failed longest candidate backtracks to a valid split", () => {
    const q = analyzeQuery("appsecurity", {
      plugins: [morphology(), dictionary({ entries: appsecDict })],
      lexicon: ["app", "security", "appsec"],
    });
    expect(q.tokens.map((t) => t.normalized)).toEqual(["app", "security"]);
  });

  test("whole known lexicon word is not split", () => {
    const q = analyzeQuery("security", {
      plugins: [morphology()],
      lexicon: ["sec", "urity", "security", "app"],
    });
    expect(q.tokens.map((t) => t.normalized)).toEqual(["security"]);
  });

  test("ambiguous valid segmentation is deterministic longest-first", () => {
    const first = analyzeQuery("abcdefgh", {
      plugins: [morphology()],
      lexicon: ["abc", "defgh", "abcd", "efgh"],
    });
    const second = analyzeQuery("abcdefgh", {
      plugins: [morphology()],
      lexicon: ["efgh", "abcd", "defgh", "abc"],
    });
    expect(first.tokens.map((t) => t.normalized)).toEqual(["abcd", "efgh"]);
    expect(second.tokens.map((t) => t.normalized)).toEqual(first.tokens.map((t) => t.normalized));
  });

  test("numeric and version tokens remain protected", () => {
    const q = analyzeQuery("tls12", {
      plugins: [morphology()],
      lexicon: ["tls", "12"],
    });
    expect(q.tokens.map((t) => t.normalized)).toEqual(["tls12"]);
    const dotted = analyzeQuery("tls 1.2", { plugins: [morphology()], prefixLexicon: ["tls", "12", "120"] });
    expect(dotted.prefixCompletion).toBeNull();
    expect(dotted.tokens.map((t) => t.normalized)).toEqual(["tls", "1", "2"]);
  });

  test("pathological long token is bounded and does not segment", () => {
    const token = "abc".repeat(80);
    const q = analyzeQuery(token, {
      plugins: [morphology()],
      lexicon: ["abc"],
    });
    expect(q.tokens).toHaveLength(1);
    expect(q.tokens[0].normalized).toBe(token);
  });

  test("compoundSpellSegment skips tokens above the repair bound without lexicon DP", () => {
    const lexicon = [];
    for (let i = 0; i < 300; i += 1) lexicon.push(`lexiconword${String(i).padStart(3, "0")}`);
    const token = "abcdefghij".repeat(8);
    expect(token.length).toBeGreaterThan(MAX_COMPOUND_REPAIR_TOKEN_LENGTH);
    expect(compoundSpellSegment(token, lexicon)).toBeNull();
    const q = analyzeQuery(token, { plugins: [morphology()], lexicon });
    expect(q.tokens).toHaveLength(1);
    expect(q.tokens[0].normalized).toBe(token);
  });
});

describe("final-token prefix completion", () => {
  test("overflowing alphabetic completions are rejected without rewriting the query", () => {
    const prefix = "pref";
    const vocab = [];
    for (let i = 0; i < 26 && vocab.length < 60; i += 1) {
      for (let j = 0; j < 26 && vocab.length < 60; j += 1) {
        vocab.push(`${prefix}${String.fromCharCode(97 + i)}${String.fromCharCode(97 + j)}`);
      }
    }
    const matching = vocab.filter(
      (w) => /^[a-z]+$/.test(w) && w.startsWith(prefix) && w.length > prefix.length
    );
    expect(matching.length).toBeGreaterThan(48);
    const q = analyzeQuery("pref", {
      plugins: [morphology()],
      lexicon: vocab,
      prefixLexicon: vocab,
    });
    expect(q.prefixCompletion).toBeNull();
    expect(q.tokens[0].normalized).toBe("pref");
    expect(q.tokens[0].lemma).toBe("pref");
  });

  test("large vocabulary still completes a unique prefix", () => {
    const vocab = ["machine", "learning"];
    for (let i = 0; i < 4000; i += 1) vocab.push(`zzzzword${i}`);
    const q = analyzeQuery("machine learni", {
      plugins: [morphology()],
      lexicon: vocab,
      prefixLexicon: vocab,
    });
    expect(q.prefixCompletion.ambiguous).toBe(false);
    expect(q.prefixCompletion.completedToken).toBe("learning");
    expect(q.prefixCompletion.canonicalToken).toBe("learn");
    expect(q.tokens[1].surface).toBe("learni");
    expect(q.tokens[1].normalized).toBe("learn");
    expect(q.tokens[1].lemma).toBe("learn");
  });

  test("explicit recursion lemmas beat equal-distance typo correction to secure", () => {
    const plugins = [morphology()];
    const lexicon = ["secure", "recursion", "recursive", "recurses"];
    const inflected = ["recurse", "recurses", "recursing", "recursive"];
    for (const query of inflected) {
      const q = analyzeQuery(query, { plugins, lexicon });
      expect(q.tokens[0].normalized).toBe("recursion");
      expect(q.tokens[0].lemma).toBe("recursion");
      expect(q.tokens[0].sources).not.toContain("typo-correction");
    }
    const identity = analyzeQuery("recursion", { plugins, lexicon });
    expect(identity.tokens[0].normalized).toBe("recursion");
    expect(identity.tokens[0].sources).not.toContain("typo-correction");
    const stub = analyzeQuery("recurs", { plugins, lexicon, prefixLexicon: lexicon });
    expect(stub.tokens[0].normalized).not.toBe("secure");
    expect(stub.tokens[0].sources).not.toContain("typo-correction");
    const secure = analyzeQuery("secure", { plugins, lexicon });
    expect(secure.tokens[0].normalized).toBe("secure");
    const resource = analyzeQuery("resource", { plugins, lexicon: ["resource", "recursion", "secure"] });
    expect(resource.tokens[0].normalized).toBe("resource");
  });

  test("analyzeQuery replaces the final token instead of mutating the pre-completion object", () => {
    const vocab = ["machine", "learning"];
    const q = analyzeQuery("machine learni", {
      plugins: [morphology()],
      lexicon: vocab,
      prefixLexicon: vocab,
    });
    expect(q.tokens[1].lemma).toBe("learn");
    expect(q.tokens[1].normalized).toBe("learn");
    expect(q.tokens[1].surface).toBe("learni");
    expect(q.tokens[1].completedToken).toBe("learning");
    expect(q.tokens[1].sources).toContain("final-token-prefix");
  });

  test("exactTitleTokenMatch uses the canonical lemma, not a unique prefix completion", () => {
    const plugins = [morphology()];
    const index = buildIndex(
      [{ id: "learn", title: "Machine Learning", body: "notes" }],
      schema,
      plugins
    );
    const doc = index.documents[0];
    const exact = analyzeQuery("learning", { plugins, lexicon: ["learning"], prefixLexicon: ["learning"] });
    expect(extractFeatures(exact, doc).exactTitleTokenMatch).toBe(false);
    expect(extractFeatures(exact, doc).typedSurfaceTitleMatch).toBe(true);
    expect(extractFeatures(exact, doc).morphologyMatch || extractFeatures(exact, doc).queryCoverage > 0).toBe(true);

    const canonical = analyzeQuery("learn", { plugins, lexicon: ["learn", "learning"], prefixLexicon: ["learn", "learning"] });
    const learnTitle = buildIndex([{ id: "learn-title", title: "Learn", body: "notes" }], schema, plugins).documents[0];
    expect(extractFeatures(canonical, learnTitle).exactTitleTokenMatch).toBe(true);
    expect(extractFeatures(canonical, learnTitle).typedSurfaceTitleMatch).toBe(true);

    const prefix = analyzeQuery("learni", {
      plugins,
      lexicon: ["learning"],
      prefixLexicon: ["learning"],
    });
    expect(prefix.prefixCompletion.completedToken).toBe("learning");
    expect(prefix.prefixCompletion.ambiguous).toBe(false);
    expect(prefix.tokens[0].surfaceNormalized).toBe("learni");
    const features = extractFeatures(prefix, doc);
    expect(features.exactTitleTokenMatch).toBe(false);
    expect(features.typedSurfaceTitleMatch).toBe(true);
    expect(features.morphologyMatch || features.queryCoverage > 0 || features.titlePrefixQuality > 0).toBe(true);
  });

  test("canonical query lemma matches a lemmatized title token", () => {
    const plugins = [morphology()];
    const index = buildIndex([{ id: "lib", title: "Library", body: "notes" }], schema, plugins);
    const q = analyzeQuery("libraries", { plugins });
    const features = extractFeatures(q, index.documents[0]);
    expect(features.exactTitleTokenMatch).toBe(true);
    expect(features.typedSurfaceTitleMatch).toBe(false);
    expect(features.morphologyMatch).toBe(false);
  });

  test("compoundSpellSegment still repairs a valid-sized glued typo", () => {
    const lexicon = ["application", "security"];
    const token = "aplicationsecurity";
    expect(token.length).toBeLessThanOrEqual(MAX_COMPOUND_REPAIR_TOKEN_LENGTH);
    expect(compoundSpellSegment(token, lexicon)).toEqual(
      expect.objectContaining({
        tokens: ["application", "security"],
      })
    );
  });
});

describe("dictionary token ownership", () => {
  test("explicit key stays one acronym concept", () => {
    const q = analyzeQuery("tls", {
      plugins: [morphology(), dictionary({ entries: [{ key: "tls", expansion: ["transport", "layer", "security"] }] })],
    });
    expect(q.concepts.filter((c) => c.kind === "acronym" && c.id === "tls")).toHaveLength(1);
    expect(q.concepts.some((c) => c.kind === "term" && c.id === "tls")).toBe(false);
  });

  test("single-token alias stays one acronym concept", () => {
    const q = analyzeQuery("ecmascript", {
      plugins: [
        morphology(),
        dictionary({
          entries: [{ key: "js", expansion: ["javascript"], aliases: [["ecmascript"]] }],
        }),
      ],
    });
    expect(q.concepts.some((c) => c.kind === "acronym" && c.id === "js" && c.provenance === "alias")).toBe(true);
    expect(q.concepts.some((c) => c.kind === "term" && (c.id === "ecmascript" || c.forms.includes("ecmascript")))).toBe(
      false
    );
  });

  test("single-token expansion canonicalizes to the same key concept as the acronym", () => {
    const plugins = [morphology(), dictionary({ entries: [{ key: "js", expansion: ["javascript"] }] })];
    const expansion = analyzeQuery("javascript", { plugins });
    const key = analyzeQuery("js", { plugins });
    expect(expansion.tokens.map((t) => t.normalized)).toEqual(key.tokens.map((t) => t.normalized));
    expect(expansion.concepts.filter((c) => c.kind === "acronym").map((c) => c.id)).toEqual(["js"]);
    expect(expansion.concepts.some((c) => c.kind === "term")).toBe(false);
    expect(key.concepts.some((c) => c.kind === "term")).toBe(false);
  });

  test("exact multi-token expansion canonicalizes to the dictionary key", () => {
    const plugins = [morphology(), dictionary({ entries: [{ key: "ml", expansion: ["machine", "learning"] }] })];
    const expansion = analyzeQuery("machine learning", { plugins });
    const key = analyzeQuery("ml", { plugins });
    expect(expansion.tokens.map((t) => t.normalized)).toEqual(key.tokens.map((t) => t.normalized));
    expect(expansion.tokens.map((t) => t.normalized)).toEqual(["machine", "learn"]);
    expect(expansion.concepts.find((c) => c.kind === "acronym")?.id).toBe("ml");
    expect(expansion.concepts.find((c) => c.kind === "acronym")?.provenance).toBe("expansion");
    expect(key.concepts.find((c) => c.kind === "acronym")?.provenance).toBe("key");
    expect(expansion.concepts.some((c) => c.kind === "term")).toBe(false);
  });
});

describe("acronym body evidence is contiguous", () => {
  test("machine learning is not full ML-equivalence from a lone learning token", async () => {
    const dict = [{ key: "ml", expansion: ["machine", "learning"] }];
    const docs = [
      { id: "learning-only", title: "Learning Resources", body: "learning without the rest of the expansion" },
      { id: "phrase", title: "Linear vs Logistic Regression", body: "machine learning appears as a phrase" },
      {
        id: "dispersed",
        title: "Unrelated Body",
        body: "machine appears early. lots of filler filler filler filler filler. later learning appears far away",
      },
    ];
    const engine = SearchEngine.create({
      schema,
      plugins: [morphology(), dictionary({ entries: dict })],
    });
    await engine.index(docs);
    const results = engine.searchDetailed("machine learning", { limit: 5, explain: true }).results;
    const learningOnly = results.find((r) => r.id === "learning-only");
    const phraseHit = results.find((r) => r.id === "phrase");
    expect(phraseHit).toBeTruthy();
    if (learningOnly) {
      expect(learningOnly.features.configuredEquivalenceMatch).not.toBe("expansion");
      expect(learningOnly.features.configuredEquivalenceMatch).not.toBe("key-in-title");
    }

    const index = buildIndex(docs, schema, [morphology(), dictionary({ entries: dict })]);
    const q = analyzeQuery("machine learning", { plugins: [morphology(), dictionary({ entries: dict })] });
    const acr = q.concepts.find((c) => c.kind === "acronym");
    const learningDoc = index.documents.find((d) => d.id === "learning-only");
    const dispersed = index.documents.find((d) => d.id === "dispersed");
    const phrase = index.documents.find((d) => d.id === "phrase");
    expect(conceptMatchesTitle(acr, learningDoc)).toBeNull();
    expect(conceptMatchesBody(acr, learningDoc)).toBe(false);
    expect(conceptMatchesBody(acr, dispersed)).toBe(false);
    expect(conceptMatchesBody(acr, phrase)).toBe(true);
  });

  test("a 1-token alias that is one expansion word is not full multi-token equivalence", async () => {
    const dict = [{ key: "ml", expansion: ["machine", "learning"], aliases: [["learning"]] }];
    const docs = [
      { id: "learning-only", title: "Learning Resources", body: "courses" },
      { id: "phrase", title: "Linear vs Logistic Regression", body: "machine learning appears as a phrase" },
    ];
    const engine = SearchEngine.create({
      schema,
      plugins: [morphology(), dictionary({ entries: dict })],
    });
    await engine.index(docs);
    const results = engine.searchDetailed("machine learning", { limit: 5, explain: true }).results;
    const learningOnly = results.find((r) => r.id === "learning-only");
    const phraseHit = results.find((r) => r.id === "phrase");
    expect(phraseHit).toBeTruthy();
    if (learningOnly) {
      expect(learningOnly.features.configuredEquivalenceMatch).not.toBe("expansion");
      expect(learningOnly.features.configuredEquivalenceMatch).not.toBe("key-in-title");
    }
  });
});

describe("public PrefixCompletion typing surface", () => {
  test("index.d.ts and types.d.ts agree on PrefixCompletion and omit alignmentStartsAtZero", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = path.dirname(fileURLToPath(import.meta.url));
    const pub = [
      fs.readFileSync(path.join(root, "../dist/index.d.ts"), "utf8"),
      fs.readFileSync(path.join(root, "../dist/api.d.ts"), "utf8"),
    ].join("\n");
    const internal = fs.readFileSync(path.join(root, "../src/types.d.ts"), "utf8");
    expect(pub).toMatch(/export interface PrefixCompletion/);
    expect(pub).toMatch(/source: "final-token-prefix"/);
    expect(internal).toMatch(/source: "final-token-prefix"/);
    expect(pub).not.toMatch(/alignmentStartsAtZero/);
    expect(internal).not.toMatch(/alignmentStartsAtZero/);
  });
});
