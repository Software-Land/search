import { compileLexicalFrequency, attachLexicalFrequency, saturatingFrequency, resolveLexicalPolicy } from "../tools/search-lexical/index.js";
import { SearchEngine, english, dictionary } from "../src/index.js";
import { analyzeQuery } from "../src/analyze.js";
import { extractFeatures, saturatingFrequency as runtimeSaturatingFrequency } from "../src/features.js";
import { saturatingFrequency as sharedSaturatingFrequency } from "../src/saturatingFrequency.js";
import {
  canonicalLexicalTokens,
  extractCanonicalNgrams,
  lexicalPhraseKeyFromQuery,
} from "../src/lexicalNormalize.js";
import { DEFAULT_STOP } from "../src/text.js";
import { buildIndex } from "../src/indexDocuments.js";
import { compareConstraint, HYBRID_CONSTRAINTS } from "../src/constraints.js";
import { readFileSync } from "node:fs";
import path from "node:path";

const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

describe("lexical-frequency compiler", () => {
  test("counts lemmatized n-grams at build time and looks them up at query time", async () => {
    const lemma = english().lemma;
    const docs = [
      {
        id: "a",
        title: "A",
        body: "machine learning machine learning machine learning machine learning machine learning",
      },
      {
        id: "b",
        title: "B",
        body: "machine learning appears twice. machine learning appears twice.",
      },
    ];
    const artifact = compileLexicalFrequency(docs, { lemma });
    expect(artifact.format).toBe("search-v2-lexical-frequency");
    expect(artifact.documents.a.ngrams["machine learn"]).toBe(5);
    expect(artifact.documents.b.ngrams["machine learn"]).toBe(2);
    expect(artifact.documents.a.ngrams.machine).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(artifact)).toBe(JSON.stringify(compileLexicalFrequency(docs, { lemma })));

    const indexed = attachLexicalFrequency(docs, artifact);
    const engine = SearchEngine.create({ schema, plugins: [english(), dictionary({ entries: [] })] });
    await engine.index(indexed);
    const row = engine.searchDetailed("machine learning", { limit: 5, explain: true }).results[0];
    expect(row.id).toBe("a");
    expect(row.features.bodyPhraseCount).toBe(5);
    expect(row.features.normalizedQueryPhrase).toBe("machine learn");
    expect(row.features.matchingPhraseKey).toBe("machine learn");
    expect(row.features.bodyPhraseFrequency).toBe(saturatingFrequency(5));
    expect(row.explanation.lexical.bodyPhraseCount).toBe(5);
  });

  test("does not keep hapax n-grams below the collection threshold", () => {
    const artifact = compileLexicalFrequency(
      [
        { id: "a", title: "A", body: "uniquephraseonlyhere" },
        { id: "b", title: "B", body: "other text" },
      ],
      { lemma: english().lemma }
    );
    expect(artifact.documents.a.ngrams.uniquephraseonlyhere).toBeUndefined();
  });

  test("unigrams and phrases share one ngram map", () => {
    const artifact = compileLexicalFrequency(
      [
        { id: "a", title: "Shard", body: "shard shard" },
        { id: "b", title: "Hot Shards", body: "shard appears here too" },
      ],
      { lemma: english().lemma }
    );
    expect(artifact.documents.a.ngrams.shard).toBe(2);
    expect(artifact.documents.a.ngrams["hot shard"]).toBeUndefined();
  });
});

describe("compiled phrase vs incidental title token", () => {
  test("repeated phrase evidence outranks a single overlapping title token", async () => {
    const docs = [
      {
        id: "phrase-doc",
        title: "Linear vs Logistic Regression",
        body: "machine learning machine learning machine learning machine learning machine learning",
        lexicalFrequency: { "machine learn": 5, machine: 5, learn: 5 },
      },
      {
        id: "title-doc",
        title: "LinkedIn Learning Review",
        body: "a course catalog with no phrase hits",
        lexicalFrequency: { learning: 1 },
      },
    ];
    const engine = SearchEngine.create({
      schema,
      plugins: [english(), dictionary({ entries: [] })],
      relationshipStrategy: "hybrid",
    });
    await engine.index(docs);
    const detailed = engine.searchDetailed("machine learning", { limit: 5, explain: true });
    expect(detailed.results[0].id).toBe("phrase-doc");
    expect(detailed.results[0].features.bodyPhraseCount).toBe(5);
    expect(detailed.results.find((r) => r.id === "title-doc").rank).toBeGreaterThan(detailed.results[0].rank);

    const a = {
      document: { id: "phrase-doc" },
      features: {
        queryTokenCount: 2,
        bodyPhraseCount: 5,
        exactTitleTokenMatch: false,
        queryCoverage: 0,
        exactTitleMatch: false,
        configuredEquivalenceMatch: false,
      },
    };
    const b = {
      document: { id: "title-doc" },
      features: {
        queryTokenCount: 2,
        bodyPhraseCount: 0,
        exactTitleTokenMatch: true,
        queryCoverage: 0.33,
        exactTitleMatch: false,
        configuredEquivalenceMatch: false,
      },
    };
    expect(compareConstraint(a, b, HYBRID_CONSTRAINTS).order).toBe(-1);
  });
});

describe("final-token prefix completion for compiled phrases", () => {
  test("incomplete final token keeps canonical phrase evidence without prefix artifact keys", async () => {
    const docs = [
      {
        id: "phrase-doc",
        title: "Linear vs Logistic Regression",
        body: "machine learning machine learning machine learning machine learning machine learning",
        lexicalFrequency: { "machine learn": 5, machine: 5, learn: 5 },
      },
      {
        id: "title-doc",
        title: "LinkedIn Learning Review",
        body: "a course catalog with no phrase hits",
        lexicalFrequency: { learning: 1 },
      },
    ];
    const artifact = compileLexicalFrequency(
      [
        { id: "phrase-doc", title: docs[0].title, body: docs[0].body },
        { id: "title-doc", title: docs[1].title, body: docs[1].body },
      ],
      { lemma: english().lemma }
    );
    expect(artifact.documents["phrase-doc"].ngrams["machine learn"]).toBe(5);
    expect(artifact.documents["phrase-doc"].ngrams["machine learni"]).toBeUndefined();
    expect(artifact.documents["phrase-doc"].ngrams["machine learnin"]).toBeUndefined();

    const engine = SearchEngine.create({
      schema,
      plugins: [english(), dictionary({ entries: [] })],
      relationshipStrategy: "hybrid",
    });
    await engine.index(docs);

    for (const query of ["machine learn", "machine learni", "machine learnin", "machine learning"]) {
      const detailed = engine.searchDetailed(query, { limit: 5, explain: true });
      const phrase = detailed.results.find((r) => r.id === "phrase-doc");
      const titleOnly = detailed.results.find((r) => r.id === "title-doc");
      expect(detailed.results[0].id).toBe("phrase-doc");
      expect(phrase.features.bodyPhraseCount).toBe(5);
      expect(phrase.features.matchingPhraseKey).toBe("machine learn");
      expect(phrase.features.normalizedQueryPhrase).toBe("machine learn");
      expect(titleOnly.rank).toBeGreaterThan(phrase.rank);
      const pc = phrase.explanation.query.prefixCompletion;
      if (query === "machine learni" || query === "machine learnin") {
        expect(pc.source).toBe("final-token-prefix");
        expect(pc.activePrefix).toMatch(/^learni/);
        expect(pc.completedToken).toBe("learning");
        expect(pc.canonicalToken).toBe("learn");
        expect(pc.ambiguous).toBe(false);
        expect(phrase.explanation.query.tokens[1].surface).toMatch(/^learni/);
        expect(phrase.explanation.query.tokens[1].normalized).toBe("learn");
        expect(phrase.explanation.query.tokens[1].lemma).toBe("learn");
      }
    }
  });

  test("distributed system typeahead keeps canonical phrase evidence", async () => {
    const rawDocs = [
      {
        id: "dist",
        title: "Consensus in Clusters",
        body: "distributed systems distributed systems distributed systems distributed systems distributed systems",
      },
      {
        id: "incidental",
        title: "System Administration Review",
        body: "pressure is incidental and mentions systems once",
      },
    ];
    const artifact = compileLexicalFrequency(rawDocs, { lemma: english().lemma });
    const phraseKey = `${english().lemma("distributed")} ${english().lemma("systems")}`;
    expect(phraseKey).toBe("distribut system");
    expect(artifact.documents.dist.ngrams[phraseKey]).toBeGreaterThanOrEqual(5);
    expect(artifact.documents.dist.ngrams["distributed syst"]).toBeUndefined();
    expect(artifact.documents.dist.ngrams["distributed syste"]).toBeUndefined();

    const engine = SearchEngine.create({
      schema,
      plugins: [english(), dictionary({ entries: [] })],
      relationshipStrategy: "hybrid",
    });
    await engine.index(attachLexicalFrequency(rawDocs, artifact));
    for (const query of ["distributed syst", "distributed syste", "distributed system", "distributed systems"]) {
      const detailed = engine.searchDetailed(query, { limit: 5, explain: true });
      expect(detailed.results[0].id).toBe("dist");
      expect(detailed.results[0].features.bodyPhraseCount).toBeGreaterThanOrEqual(5);
      expect(detailed.results[0].features.matchingPhraseKey).toBe(phraseKey);
    }
  });

  test("ambiguous short-ish prefixes are not rewritten to one arbitrary word", () => {
    const q = analyzeQuery("open inter", {
      plugins: [english()],
      lexicon: ["open", "interface", "interceptor", "internet"],
      prefixLexicon: ["open", "interface", "interceptor", "internet"],
    });
    expect(q.tokens[1].normalized).toBe("inter");
    expect(q.tokens[1].lemma).toBe("inter");
    expect(q.prefixCompletion.ambiguous).toBe(true);
    expect(q.prefixCompletion.canonicalToken).toBeNull();
    expect(q.prefixCompletion.canonicalTokens).toEqual(
      expect.arrayContaining(["interface", "interceptor", "internet"])
    );
    expect(q.prefixCompletion.completedTokens).toEqual(
      expect.arrayContaining(["interface", "interceptor", "internet"])
    );
  });

  test("ambiguous prefix completions do not contribute compiled phrase keys", async () => {
    const rawDocs = [
      {
        id: "iface",
        title: "Unrelated Title",
        body: "interface interface interface interface interface",
      },
      {
        id: "other",
        title: "Other Title",
        body: "interface also appears in this body once more interface",
      },
      { id: "open", title: "Open Notes", body: "open open" },
      { id: "interface-title", title: "Interface", body: "x" },
      { id: "interceptor", title: "Interceptor", body: "x" },
      { id: "internet", title: "Internet", body: "x" },
    ];
    const artifact = compileLexicalFrequency(rawDocs, { lemma: english().lemma });
    expect(artifact.documents.iface.ngrams.interface).toBeGreaterThanOrEqual(2);

    const engine = SearchEngine.create({ schema, plugins: [english()] });
    await engine.index(attachLexicalFrequency(rawDocs, artifact));
    const detailed = engine.searchDetailed("open inter", { limit: 8, explain: true });
    const pc = detailed.results[0].explanation.query.prefixCompletion;
    expect(pc.ambiguous).toBe(true);
    expect(pc.canonicalTokens).toEqual(expect.arrayContaining(["interface", "interceptor", "internet"]));
    const iface = detailed.results.find((r) => r.id === "iface");
    expect(iface.features.matchingPhraseKey).not.toBe("interface");
    expect(iface.features.matchingPhraseKey).not.toBe("open interface");
    expect(String(iface.features.normalizedQueryPhrase)).not.toMatch(/interface|interceptor|internet/);
    expect(iface.features.bodyPhraseCount).toBe(0);
  });

  test("what is an appli does not pick an arbitrary appli* phrase key", async () => {
    const rawDocs = [
      {
        id: "api",
        title: "What is an API?",
        body: "application application application application application",
      },
      {
        id: "other",
        title: "Other",
        body: "application also appears here application",
      },
      { id: "appliances", title: "Appliances", body: "x" },
      { id: "applicable", title: "Applicable", body: "x" },
      { id: "application", title: "Application", body: "x" },
      { id: "applied", title: "Applied", body: "x" },
      { id: "applies", title: "Applies", body: "x" },
    ];
    const artifact = compileLexicalFrequency(rawDocs, { lemma: english().lemma });
    const engine = SearchEngine.create({ schema, plugins: [english()] });
    await engine.index(attachLexicalFrequency(rawDocs, artifact));
    const detailed = engine.searchDetailed("what is an appli", { limit: 8, explain: true });
    const pc = detailed.results[0].explanation.query.prefixCompletion;
    expect(pc.ambiguous).toBe(true);
    const row = detailed.results.find((r) => r.id === "api");
    expect(row.features.matchingPhraseKey).not.toBe("application");
    expect(row.features.matchingPhraseKey).not.toBe("applicat");
    expect(row.features.bodyPhraseCount).toBe(0);
  });

  test("punctuation junk and inflections do not make a unique completion ambiguous", () => {
    const q = analyzeQuery("machine learni", {
      plugins: [english()],
      lexicon: ["machine", "learning", "learning*", "learning**", "learnings"],
      prefixLexicon: ["machine", "learning", "learning*", "learning**", "learnings"],
    });
    expect(q.prefixCompletion.ambiguous).toBe(false);
    expect(q.prefixCompletion.activePrefix).toBe("learni");
    expect(q.prefixCompletion.completedToken).toBe("learning");
    expect(q.prefixCompletion.canonicalToken).toBe("learn");
    expect(q.tokens[1].surface).toBe("learni");
    expect(q.tokens[1].normalized).toBe("learn");
    expect(q.tokens[1].lemma).toBe("learn");
    expect(q.prefixCompletion.completedTokens).toEqual(["learning", "learnings"]);
  });

  test("numeric final tokens keep strict version behavior", () => {
    const q = analyzeQuery("tls 12", {
      plugins: [english()],
      lexicon: ["tls", "12", "120", "128"],
      prefixLexicon: ["tls", "12", "120", "128"],
    });
    expect(q.prefixCompletion).toBeNull();
    expect(q.tokens[1].normalized).toBe("12");
    expect(q.tokens[1].lemma).toBe("12");
  });
});

describe("english lemma merge policy", () => {
  test("site lemmas augment defaults and do not replace explicit defaults", () => {
    const plugin = english({
      lemmas: {
        computing: "comput",
        libraries: "libz",
        foobars: "foobaz",
      },
    });
    expect(plugin.lemma("computing")).toBe("compute");
    expect(plugin.lemma("libraries")).toBe("library");
    expect(plugin.lemma("foobars")).toBe("foobaz");
  });

  test("compute and computing still match a Computing title", () => {
    const qCompute = analyzeQuery("compute", { plugins: [english({ lemmas: { computing: "comput" } })] });
    const qComputing = analyzeQuery("computing", { plugins: [english({ lemmas: { computing: "comput" } })] });
    expect(qCompute.tokens[0].lemma).toBe("compute");
    expect(qComputing.tokens[0].lemma).toBe("compute");
    const index = buildIndex(
      [{ id: "edge", title: "Edge Computing", body: "edge" }],
      schema,
      [english({ lemmas: { computing: "comput" } })]
    );
    const f1 = extractFeatures(qCompute, index.documents[0]);
    const f2 = extractFeatures(qComputing, index.documents[0]);
    expect(f1.morphologyMatch || f1.exactTitleTokenMatch || f1.queryCoverage > 0).toBe(true);
    expect(f2.morphologyMatch || f2.queryCoverage > 0).toBe(true);
  });
});

describe("lexical compiler body-only n-grams", () => {
  test("does not invent a title/body boundary bigram", () => {
    const lemma = english().lemma;
    const artifact = compileLexicalFrequency(
      [
        { id: "a", title: "Machine", body: "Learning is useful" },
        { id: "b", title: "Other", body: "machine learning is useful" },
        { id: "c", title: "Third", body: "machine learning also appears" },
      ],
      { lemma }
    );
    expect(artifact.documents.a.ngrams["machine learn"]).toBeUndefined();
    expect(artifact.documents.a.ngrams.machine).toBeUndefined();
    expect(artifact.documents.b.ngrams["machine learn"]).toBe(1);
  });

  test("bodyPhraseCount is body occurrences only", async () => {
    const lemma = english().lemma;
    const docs = [
      { id: "title-and-body", title: "Machine Learning", body: "machine learning is discussed once" },
      { id: "two-body", title: "Unrelated", body: "machine learning and more machine learning" },
      { id: "title-only", title: "Machine Learning", body: "no phrase here" },
      { id: "fill", title: "Fill", body: "machine learning filler so collection keeps the phrase" },
    ];
    const artifact = compileLexicalFrequency(docs, { lemma });
    expect(artifact.documents["title-and-body"].ngrams["machine learn"]).toBe(1);
    expect(artifact.documents["two-body"].ngrams["machine learn"]).toBe(2);
    expect(artifact.documents["title-only"].ngrams["machine learn"]).toBeUndefined();

    const engine = SearchEngine.create({
      schema,
      plugins: [english(), dictionary({ entries: [] })],
    });
    await engine.index(attachLexicalFrequency(docs, artifact));
    expect(
      engine.searchDetailed("machine learning", { explain: true }).results.find((r) => r.id === "title-and-body")
        .features.bodyPhraseCount
    ).toBe(1);
    expect(
      engine.searchDetailed("machine learning", { explain: true }).results.find((r) => r.id === "two-body").features
        .bodyPhraseCount
    ).toBe(2);
    expect(
      engine.searchDetailed("machine learning", { explain: true }).results.find((r) => r.id === "title-only").features
        .bodyPhraseCount
    ).toBe(0);
  });
});

describe("compiler/runtime lexical normalization parity", () => {
  test("compiler keys match runtime phrase lookup for representative inputs", () => {
    const lemma = english().lemma;
    const policy = { minN: 1, maxN: 2 };
    for (const text of ["machine learning", "foo the bar", "what is code", "libraries", "computing", "machine learnings"]) {
      const compiled = extractCanonicalNgrams(canonicalLexicalTokens(text, { lemma }), policy);
      const analyzed = analyzeQuery(text, { plugins: [english()] });
      const runtimeKey = lexicalPhraseKeyFromQuery(analyzed.tokens);
      expect(compiled).toContain(runtimeKey);
    }
    const foo = extractCanonicalNgrams(canonicalLexicalTokens("foo the bar", { lemma }), policy);
    expect(foo).toContain("foo bar");
    expect(foo).not.toContain("foo the");
    expect(foo).not.toContain("the bar");
  });

  test("public lexical declaration has no custom stopWords option", () => {
    const dts = readFileSync(path.join("tools", "search-lexical", "index.d.ts"), "utf8");
    expect(dts).not.toMatch(/\bstopWords\b/);
  });

  test("compiler uses DEFAULT_STOP even if a caller still passes stopWords", () => {
    expect(DEFAULT_STOP.has("the")).toBe(true);
    expect(DEFAULT_STOP.has("bar")).toBe(false);
    const lemma = english().lemma;
    const docs = [
      { id: "a", title: "A", body: "foo the bar foo the bar" },
      { id: "b", title: "B", body: "foo the bar also appears" },
    ];
    const artifact = compileLexicalFrequency(docs, {
      lemma,
      stopWords: new Set(["bar"]),
    });
    expect(artifact.documents.a.ngrams["foo bar"]).toBe(2);
    expect(artifact.documents.a.ngrams["foo the"]).toBeUndefined();
    expect(artifact.documents.a.ngrams.bar).toBe(2);
    const runtimeKey = lexicalPhraseKeyFromQuery(analyzeQuery("foo the bar", { plugins: [english()] }).tokens);
    expect(runtimeKey).toBe("foo bar");
    expect(artifact.documents.a.ngrams[runtimeKey]).toBe(2);
  });
});

describe("lexical policy validation", () => {
  test("rejects non-finite or inverted n-gram policy values", () => {
    expect(() => resolveLexicalPolicy({ minN: Number.NaN })).toThrow(/minN/);
    expect(() => resolveLexicalPolicy({ maxN: 0 })).toThrow(/maxN/);
    expect(() => resolveLexicalPolicy({ minCollectionCount: 1.5 })).toThrow(/minCollectionCount/);
    expect(() => resolveLexicalPolicy({ minN: 3, maxN: 1 })).toThrow(/maxN/);
    expect(resolveLexicalPolicy(undefined)).toEqual({ minN: 1, maxN: 2, minCollectionCount: 2 });
  });
});

describe("lexical compiler duplicate-id parity", () => {
  test("last document wins before collection counts, matching SearchEngine.index", async () => {
    const lemma = english().lemma;
    const docs = [
      { id: "dup", title: "First Title", body: "hapaxphrase hapaxphrase hapaxphrase" },
      { id: "dup", title: "Last Title", body: "unrelated filler" },
      { id: "other", title: "Other", body: "unrelated filler hapaxphrase" },
    ];
    const artifact = compileLexicalFrequency(docs, { lemma });
    expect(artifact.documents.dup.ngrams.hapaxphrase).toBeUndefined();
    expect(artifact.documents.other.ngrams.hapaxphrase).toBeUndefined();

    const engine = SearchEngine.create({ schema, plugins: [english()] });
    await engine.index(docs);
    const hit = engine.search("Last Title")[0];
    expect(hit.title).toBe("Last Title");
    expect(engine.search("First Title")[0]?.title).not.toBe("First Title");
  });

  test("padded ids compile, attach, and index under the same canonical id", async () => {
    const lemma = english().lemma;
    const docs = [
      { id: " foo ", title: "Foo", body: "sharedphrase sharedphrase" },
      { id: "bar", title: "Bar", body: "sharedphrase appears here too" },
    ];
    const artifact = compileLexicalFrequency(docs, { lemma });
    expect(artifact.documents.foo.ngrams.sharedphrase).toBe(2);
    expect(artifact.documents[" foo "]).toBeUndefined();
    const attached = attachLexicalFrequency(docs, artifact);
    expect(attached[0].lexicalFrequency.sharedphrase).toBe(2);
    const engine = SearchEngine.create({ schema, plugins: [english()] });
    await engine.index(attached);
    const hit = engine.searchDetailed("sharedphrase", { explain: true }).results.find((r) => r.id === "foo");
    expect(hit).toBeTruthy();
    expect(hit.features.bodyPhraseCount).toBe(2);
  });
});

describe("shared saturatingFrequency", () => {
  test("runtime, tool re-export, and shared module are the same function result", () => {
    expect(runtimeSaturatingFrequency(5)).toBe(saturatingFrequency(5));
    expect(sharedSaturatingFrequency(5)).toBe(saturatingFrequency(5));
    expect(saturatingFrequency(0)).toBe(0);
  });
});

describe("copyLexicalFrequency accepted shapes", () => {
  test("indexes flat records and ngrams objects, and rejects arrays", async () => {
    const engine = SearchEngine.create({ schema, plugins: [english()] });
    await engine.index([
      { id: "flat", title: "Flat", body: "machine learning", lexicalFrequency: { "machine learn": 4, machine: 4 } },
      { id: "nested", title: "Nested", body: "machine learning", lexicalFrequency: { ngrams: { "machine learn": 3 }, ignored: 9 } },
      { id: "array", title: "Array", body: "machine learning", lexicalFrequency: ["machine learn"] },
    ]);
    const q = "machine learning";
    expect(engine.searchDetailed(q, { explain: true }).results.find((r) => r.id === "flat").features.bodyPhraseCount).toBe(
      4
    );
    expect(
      engine.searchDetailed(q, { explain: true }).results.find((r) => r.id === "nested").features.bodyPhraseCount
    ).toBe(3);
    expect(
      engine.searchDetailed(q, { explain: true }).results.find((r) => r.id === "array").features.bodyPhraseCount
    ).toBe(0);
  });
});
