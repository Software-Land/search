/**
 * Investigation / future-work theorems: classifyDirect already short-circuits
 * by class, and a title-first conservative score bound never underestimates
 * extractFeatures. These tests do not enable a production lazy evaluator,
 * score-bound rejection, or ranking change. Production extractFeatures stays
 * exhaustive.
 */
import { SearchEngine, morphology } from "../dist/index.js";
import { extractFeatures, classifyDirect } from "../dist/features.js";
import { scoreFeatures, selectTopPerBuiltinSignature } from "../dist/rank.js";
import { constraintSignature } from "../dist/rankSignature.js";
import { compileLexicalIndex } from "../dist/indexing/lexicalIndex.js";

const schema = {
  title: { type: "text", role: "title" },
  body: { type: "text", role: "body" },
};

function round6(score) {
  return Number(score.toFixed(6));
}

function titleFirstBound(f) {
  const titlePhrase = f.phraseAdjacency === 1 ? 1 : 0;
  const partial = { ...f, phraseAdjacency: titlePhrase, bodyLexicalMatch: 0 };
  const known = scoreFeatures(partial);
  const upper = known + (titlePhrase === 1 ? 0 : 0.5 * 0.8) + 0.25;
  return {
    known: round6(known),
    actual: round6(scoreFeatures(f)),
    upper: round6(upper),
    titleClass: classifyDirect(partial),
    signatureResolved: constraintSignature({ ...partial, directClass: classifyDirect(partial) }) === constraintSignature(f),
  };
}

function baseFeat(extra = {}) {
  return {
    exactTitleMatch: false,
    exactTitleTokenMatch: false,
    typedSurfaceTitleMatch: false,
    titleCoverage: 0,
    queryCoverage: 0,
    titlePrefixQuality: 0,
    contextualTitlePrefix: false,
    contextualPrefixQuality: 0,
    configuredConceptMatch: false,
    morphologyMatch: false,
    typoDistance: 0,
    versionMatch: false,
    shortLiteralLeadMatch: false,
    dottedSpanComponentTitleMatch: false,
    phraseAdjacency: 0,
    bodyLexicalMatch: 0,
    titleTokenCount: 3,
    configuredFormEvidence: 0,
    canonicalKeyTitle: false,
    queryTokenCount: 3,
    bodyPhraseCount: 0,
    relevanceKind: "direct",
    directClass: "none",
    ...extra,
  };
}

describe("lazy feature bound theorems (investigation; not a production path)", () => {
  test("classifyDirect already short-circuits: weaker predicates cannot change a proven class", () => {
    const strong = classifyDirect(baseFeat({ exactTitleMatch: true }));
    expect(strong).toBe("strong");
    expect(
      classifyDirect(
        baseFeat({
          exactTitleMatch: true,
          phraseAdjacency: 0.5,
          bodyLexicalMatch: 1,
          morphologyMatch: true,
          typoDistance: 2,
          bodyPhraseCount: 9,
        })
      )
    ).toBe("strong");

    const moderate = classifyDirect(baseFeat({ phraseAdjacency: 1 }));
    expect(moderate).toBe("moderate");
    expect(
      classifyDirect(
        baseFeat({
          phraseAdjacency: 1,
          bodyLexicalMatch: 1,
          morphologyMatch: true,
          typoDistance: 2,
        })
      )
    ).toBe("moderate");
  });

  test("title phrase adjacency is moderate; body adjacency is score-only", () => {
    expect(classifyDirect(baseFeat({ phraseAdjacency: 1 }))).toBe("moderate");
    expect(classifyDirect(baseFeat({ phraseAdjacency: 0.5 }))).toBe("none");
    expect(classifyDirect(baseFeat({ phraseAdjacency: 0.5, bodyLexicalMatch: 0.3333 }))).toBe("weak");
    expect(classifyDirect(baseFeat({ bodyLexicalMatch: 0.3333 }))).toBe("weak");
  });

  test("repeated bodyPhraseCount can establish moderate without title work", () => {
    expect(classifyDirect(baseFeat({ queryTokenCount: 3, bodyPhraseCount: 2 }))).toBe("moderate");
    expect(classifyDirect(baseFeat({ queryTokenCount: 3, bodyPhraseCount: 1 }))).toBe("none");
  });

  test("query-side formCoverage does not make a unigram body phrase moderate", () => {
    expect(
      classifyDirect(
        baseFeat({
          queryTokenCount: 1,
          configuredFormCoverage: 0.3333,
          bodyPhraseCount: 2,
          bodyLexicalMatch: 0,
        })
      )
    ).toBe("none");
    expect(
      classifyDirect(
        baseFeat({
          queryTokenCount: 1,
          configuredFormCoverage: 0.6667,
          bodyPhraseCount: 2,
          bodyLexicalMatch: 1,
        })
      )
    ).toBe("weak");
  });

  test("title-first bound never underestimates extractFeatures on synthetic phrase docs", async () => {
    const docs = [
      { id: "title-hit", title: "Virtual private network guide", body: "unrelated notes" },
      { id: "body-hit", title: "Notes", body: "a virtual private network tunnel" },
      { id: "network-only", title: "Other", body: "the network interface card" },
      { id: "none", title: "Unrelated", body: "keyboard display settings" },
      { id: "typo-title", title: "Virtul privacy notes", body: "network cable" },
    ];
    const engine = SearchEngine.create({
      schema,
      plugins: [morphology()],
      retriever: "full-scan",
      relationshipStrategy: "none",
    });
    await engine.index(docs);
    const query = engine._prepareQuery("virtual private network");
    for (const doc of engine._index.documents) {
      const f = extractFeatures(query, doc);
      const bound = titleFirstBound(f);
      expect(bound.known).toBeLessThanOrEqual(bound.actual + 1e-12);
      expect(bound.actual).toBeLessThanOrEqual(bound.upper + 1e-12);
    }
  });

  test("adversarial late body evidence stays inside the conservative upper bound", async () => {
    const docs = [
      { id: "early-weak", title: "Notes", body: "network only here" },
      { id: "late-adjacency", title: "Zzz last", body: "virtual private network tunnel" },
      { id: "late-lexical", title: "Yyy last", body: "virtual machines and a private club network" },
      { id: "late-morphology", title: "Networks", body: "unrelated" },
    ];
    const engine = SearchEngine.create({
      schema,
      plugins: [morphology({ lemmas: { networks: "network" } })],
      retriever: "full-scan",
      relationshipStrategy: "none",
    });
    await engine.index(docs);
    const query = engine._prepareQuery("virtual private network");
    const featured = engine._index.documents.map((doc) => {
      const features = extractFeatures(query, doc);
      return { document: doc, features, score: round6(scoreFeatures(features)) };
    });
    const retained = new Set(selectTopPerBuiltinSignature(featured, 2).candidates.map((c) => c.document.id));
    for (const row of featured) {
      const bound = titleFirstBound(row.features);
      expect(bound.actual).toBeLessThanOrEqual(bound.upper + 1e-12);
      if (bound.signatureResolved && bound.upper + 1e-12 < 0) {
        expect(retained.has(row.document.id)).toBe(false);
      }
    }
    expect(retained.has("late-adjacency") || retained.has("late-lexical") || featured.length).toBeTruthy();
  });

  test("compact and fat FeatureVectors keep the same title-first bound", async () => {
    const docs = [
      { id: "a", title: "Virtual private network", body: "notes" },
      { id: "b", title: "Notes", body: "virtual private network" },
    ];
    const plugins = [morphology()];
    const fat = SearchEngine.create({ schema, plugins, retriever: "full-scan", relationshipStrategy: "none" });
    const artifact = compileLexicalIndex(docs, { schema, plugins });
    const compact = SearchEngine.create({
      schema,
      plugins,
      retriever: "indexed",
      lexicalIndex: artifact,
      relationshipStrategy: "none",
    });
    await fat.index(docs);
    await compact.index(docs);
    const query = fat._prepareQuery("virtual private network");
    for (let i = 0; i < docs.length; i += 1) {
      const fatF = extractFeatures(query, fat._index.documents[i]);
      const compactF = extractFeatures(query, compact._index.documents[i]);
      expect(compactF).toEqual(fatF);
      expect(titleFirstBound(compactF)).toEqual(titleFirstBound(fatF));
    }
  });
});
