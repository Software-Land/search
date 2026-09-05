/**
 * Hybrid full-body multi-concept over weak lexical-subset.
 * queryCoverage stays title-only; bodyLexicalMatch stays body-only;
 * lexicalConceptCoverage is the true title∪body union. Synthetic ranking
 * plus one complementary-evidence extractFeatures case.
 */
import { HYBRID_CONSTRAINTS, compareConstraint, DEFAULT_CONSTRAINTS } from "../dist/constraints.js";
import { rankCandidates, lastRankStats } from "../dist/rank.js";
import { rankCandidatesPairwise } from "../build/test/oracles/rankOracle.js";
import { FULL_QUERY_COVERAGE } from "../dist/evidencePolicy.js";
import { analyzeQuery } from "../dist/query/analyze.js";
import { extractFeatures } from "../dist/features.js";
import { buildIndex } from "../dist/indexDocuments.js";
import { morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";

function hit(id, over = {}) {
  return {
    document: { id, title: id },
    features: {
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
      lexicalConceptCoverage: 0,
      coverageConceptCount: 2,
      titleTokenCount: 3,
      configuredFormEvidence: 0,
      canonicalKeyTitle: false,
      queryTokenCount: 2,
      bodyPhraseCount: 0,
      relationshipStrength: 0,
      relationshipType: null,
      relationshipSourceId: null,
      retrievalScore: 0,
      relevanceKind: "direct",
      directClass: "weak",
      ...over,
    },
  };
}

const constraintId = "full-body-multi-concept-over-weak-subset";
const fn = HYBRID_CONSTRAINTS.find((c) => c.id === constraintId).fn;

function fullBody(id, extra = {}) {
  return hit(id, {
    queryCoverage: 0,
    bodyLexicalMatch: 1,
    lexicalConceptCoverage: 1,
    coverageConceptCount: 2,
    directClass: "weak",
    ...extra,
  });
}

function weakSubset(id, extra = {}) {
  return hit(id, {
    queryCoverage: 0.5,
    bodyLexicalMatch: 0.5,
    lexicalConceptCoverage: 0.5,
    coverageConceptCount: 2,
    exactTitleTokenMatch: true,
    directClass: "weak",
    ...extra,
  });
}

function complementaryUnion(id, extra = {}) {
  return hit(id, {
    queryCoverage: 0.5,
    bodyLexicalMatch: 0.5,
    lexicalConceptCoverage: 1,
    coverageConceptCount: 2,
    directClass: "weak",
    ...extra,
  });
}

function publicIds(ranked) {
  return ranked.map((row) => row.document.id);
}

describe("full-body multi-concept over weak lexical subset", () => {
  test("constraint is hybrid-only", () => {
    expect(DEFAULT_CONSTRAINTS.some((c) => c.id === constraintId)).toBe(false);
    expect(HYBRID_CONSTRAINTS.some((c) => c.id === constraintId)).toBe(true);
  });

  test("2 concepts, full body vs weak 1/2 lexical union => full body wins", () => {
    const a = fullBody("full-body");
    const b = weakSubset("subset");
    expect(fn(a, b)).toBe(-1);
    expect(fn(b, a)).toBe(1);
    const cmp = compareConstraint(a, b, HYBRID_CONSTRAINTS);
    expect(cmp.order).toBe(-1);
    expect(cmp.applied.some((row) => row.id === constraintId && row.result === "A>B")).toBe(true);
  });

  test("reversed orientation still prefers full body", () => {
    const a = weakSubset("subset");
    const b = fullBody("full-body");
    expect(fn(a, b)).toBe(1);
    expect(fn(b, a)).toBe(-1);
    expect(compareConstraint(a, b, HYBRID_CONSTRAINTS).order).toBe(1);
  });

  test("full body vs weak full lexical union is neutral", () => {
    const a = fullBody("full-body");
    const b = complementaryUnion("split-union");
    expect(fn(a, b)).toBe(0);
    expect(fn(b, a)).toBe(0);
  });

  test("both sides with full lexical coverage are neutral", () => {
    const a = fullBody("a");
    const b = fullBody("b", { queryCoverage: 0.5 });
    expect(fn(a, b)).toBe(0);
  });

  test("both sides with full body coverage are neutral", () => {
    expect(fn(fullBody("a"), fullBody("b"))).toBe(0);
  });

  test("preferred candidate with only partial body coverage is neutral", () => {
    const partialBody = hit("partial-body", {
      bodyLexicalMatch: 0.5,
      lexicalConceptCoverage: 1,
      coverageConceptCount: 2,
      directClass: "weak",
    });
    expect(fn(partialBody, weakSubset("subset"))).toBe(0);
    expect(fn(weakSubset("subset"), partialBody)).toBe(0);
  });

  test("1 coverage concept does not fire even when queryTokenCount > 1", () => {
    const a = fullBody("full-body", { coverageConceptCount: 1, queryTokenCount: 3 });
    const b = weakSubset("subset", { coverageConceptCount: 1, queryTokenCount: 3 });
    expect(fn(a, b)).toBe(0);
    expect(fn(b, a)).toBe(0);
  });

  test("full body vs moderate partial-title is neutral", () => {
    const moderate = weakSubset("moderate-title", { directClass: "moderate" });
    expect(fn(fullBody("full-body"), moderate)).toBe(0);
    expect(fn(moderate, fullBody("full-body"))).toBe(0);
  });

  test("full body vs strong partial-title is neutral", () => {
    const strong = weakSubset("strong-title", { directClass: "strong", exactTitleMatch: true });
    expect(fn(fullBody("full-body"), strong)).toBe(0);
    expect(fn(strong, fullBody("full-body"))).toBe(0);
  });

  test("neither side satisfying the complete predicate is neutral", () => {
    const a = weakSubset("a");
    const b = weakSubset("b", { lexicalConceptCoverage: 0 });
    expect(fn(a, b)).toBe(0);
  });

  test("related neighbors are not subset competitors", () => {
    const related = weakSubset("related", { relevanceKind: "related", directClass: "none" });
    expect(fn(fullBody("full-body"), related)).toBe(0);
    expect(fn(related, fullBody("full-body"))).toBe(0);
  });

  test("complementary title+body evidence is not a strict-subset competitor", () => {
    const x = complementaryUnion("title-or-body");
    const y = fullBody("full-body");
    expect(x.features.queryCoverage).toBe(0.5);
    expect(x.features.bodyLexicalMatch).toBe(0.5);
    expect(x.features.lexicalConceptCoverage).toBe(1);
    expect(fn(y, x)).toBe(0);
    expect(fn(x, y)).toBe(0);
  });

  test("sparse rank matches pairwise for firing and complementary cases", () => {
    const pairs = [
      [fullBody("full-body"), weakSubset("subset")],
      [weakSubset("subset"), fullBody("full-body")],
      [fullBody("full-body"), complementaryUnion("split")],
      [fullBody("a"), fullBody("b")],
      [fullBody("full-body", { coverageConceptCount: 1 }), weakSubset("subset", { coverageConceptCount: 1 })],
    ];
    for (const cands of pairs) {
      const expected = rankCandidatesPairwise(cands, { constraints: HYBRID_CONSTRAINTS });
      const actual = rankCandidates(cands, { constraints: HYBRID_CONSTRAINTS });
      expect(publicIds(actual)).toEqual(publicIds(expected));
      expect(lastRankStats().mode).toBe("sparse");
    }
  });
});

describe("lexicalConceptCoverage extractFeatures", () => {
  const schema = { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } };

  test("complementary title/body evidence has full union, not half+half", () => {
    const index = buildIndex(
      [
        { id: "x", title: "alpha notes", body: "beta appears in this body" },
        { id: "y", title: "unrelated title", body: "alpha and beta both appear here" },
      ],
      schema,
      [morphology()]
    );
    const query = analyzeQuery("alpha beta", { plugins: [morphology()] });
    expect(query.concepts.filter((c) => c.kind === "term").length).toBeGreaterThanOrEqual(2);
    const x = extractFeatures(query, index.documents.find((d) => d.id === "x"));
    const y = extractFeatures(query, index.documents.find((d) => d.id === "y"));
    expect(x.coverageConceptCount).toBe(2);
    expect(x.queryCoverage).toBe(0.5);
    expect(x.bodyLexicalMatch).toBe(0.5);
    expect(x.lexicalConceptCoverage).toBe(1);
    expect(y.coverageConceptCount).toBe(2);
    expect(y.queryCoverage).toBe(0);
    expect(y.bodyLexicalMatch).toBe(1);
    expect(y.lexicalConceptCoverage).toBe(1);
    expect(y.directClass).toBe("weak");
    const xHit = hit("x", x);
    const yHit = hit("y", y);
    expect(fn(yHit, xHit)).toBe(0);
    expect(fn(xHit, yHit)).toBe(0);
  });

  test("configured expansion with queryTokenCount > 1 still has one coverage concept", () => {
    const tlsDict = [{ key: "tls", aliases: [["transport", "layer", "security"]]}];
    const plugins = [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: tlsDict })];
    const index = buildIndex(
      [
        { id: "full-body", title: "Unrelated", body: "transport layer security appears in the body" },
        { id: "partial", title: "Transport notes", body: "no security here" },
      ],
      schema,
      plugins
    );
    const query = analyzeQuery("tls", { plugins });
    expect(query.tokens.length).toBeGreaterThanOrEqual(1);
    const full = extractFeatures(query, index.documents.find((d) => d.id === "full-body"));
    const partial = extractFeatures(query, index.documents.find((d) => d.id === "partial"));
    expect(full.coverageConceptCount).toBe(1);
    expect(full.queryTokenCount).toBeGreaterThan(1);
    expect(fn(hit("full-body", full), hit("partial", partial))).toBe(0);
  });
});
