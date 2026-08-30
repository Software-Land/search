/**
 * Hybrid related-over-weak-direct: repeated compiled bodyPhraseCount stays
 * unordered so score can prefer either side. Not a public ranking policy change
 * beyond that exemption. Synthetic features only.
 */
import { HYBRID_CONSTRAINTS, compareConstraint, DEFAULT_CONSTRAINTS } from "../dist/constraints.js";
import { rankCandidates, lastRankStats, scoreFeatures } from "../dist/rank.js";
import { REPEATED_BODY_PHRASE_MIN } from "../dist/evidencePolicy.js";

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
      titleTokenCount: 3,
      configuredFormEvidence: 0,
      canonicalKeyTitle: false,
      queryTokenCount: 1,
      bodyPhraseCount: 0,
      relationshipStrength: 0,
      relationshipType: null,
      relationshipSourceId: null,
      retrievalScore: 0,
      relevanceKind: "direct",
      directClass: "none",
      ...over,
    },
  };
}

const relatedOverWeakFn = HYBRID_CONSTRAINTS.find((c) => c.id === "related-over-weak-direct").fn;

function related(id, strength) {
  return hit(id, {
    relevanceKind: "related",
    directClass: "none",
    relationshipStrength: strength,
    bodyPhraseCount: 0,
    bodyLexicalMatch: 0,
  });
}

function weakBody(id, bodyPhraseCount, extra = {}) {
  return hit(id, {
    relevanceKind: "direct",
    directClass: "weak",
    bodyLexicalMatch: 1,
    bodyPhraseCount,
    queryCoverage: 0,
    ...extra,
  });
}

describe("related-over-weak-direct repeated body exemption", () => {
  test("related still outranks a weak-direct below the repeated-phrase threshold", () => {
    const rel = related("rel", 0.4);
    const weak = weakBody("weak", REPEATED_BODY_PHRASE_MIN - 1);
    expect(relatedOverWeakFn(rel, weak)).toBe(-1);
    expect(relatedOverWeakFn(weak, rel)).toBe(1);
    const cmp = compareConstraint(rel, weak, HYBRID_CONSTRAINTS);
    expect(cmp.order).toBe(-1);
    expect(cmp.applied.some((row) => row.id === "related-over-weak-direct" && row.result === "A>B")).toBe(true);
  });

  test("constraint is neutral at the repeated-phrase threshold", () => {
    const rel = related("rel", 0.4);
    const weak = weakBody("weak", REPEATED_BODY_PHRASE_MIN);
    expect(relatedOverWeakFn(rel, weak)).toBe(0);
    expect(relatedOverWeakFn(weak, rel)).toBe(0);
    expect(compareConstraint(rel, weak, HYBRID_CONSTRAINTS).order).toBe(0);
  });

  test("constraint is neutral above the repeated-phrase threshold", () => {
    const rel = related("rel", 0.4);
    const weak = weakBody("weak", REPEATED_BODY_PHRASE_MIN + 8);
    expect(relatedOverWeakFn(rel, weak)).toBe(0);
    expect(relatedOverWeakFn(weak, rel)).toBe(0);
  });

  test("unigram configured mentions do not exempt", () => {
    const rel = related("rel", 0.4);
    const weak = weakBody("weak", 16, {
      queryTokenCount: 1,
      configuredConceptFieldEvidence: { title: false, summary: false, body: "key" },
    });
    expect(relatedOverWeakFn(rel, weak)).toBe(-1);
  });

  test("related still outranks a weak summary configured mention", () => {
    const rel = related("rel", 0.495);
    const summary = weakBody("sum", 0, {
      configuredConceptFieldEvidence: { title: false, summary: "key", body: "key" },
      relationshipStrength: 0,
    });
    expect(relatedOverWeakFn(rel, summary)).toBe(-1);
    const ranked = rankCandidates([summary, rel], { constraints: HYBRID_CONSTRAINTS });
    expect(ranked.map((row) => row.document.id)).toEqual(["rel", "sum"]);
  });

  test("summary-over-body does not demote a related-attached body mention via transitivity", () => {
    const iface = weakBody("iface", 1, {
      configuredConceptFieldEvidence: { title: false, summary: false, body: "key" },
      relationshipStrength: 0.512,
    });
    const refactor = weakBody("refactor", 0, {
      configuredConceptFieldEvidence: { title: false, summary: "key", body: "key" },
      relationshipStrength: 0.43,
    });
    const neighbor = related("class", 0.495);
    expect(HYBRID_CONSTRAINTS.find((c) => c.id === "configured-summary-over-body-mention")).toBeUndefined();
    const ranked = rankCandidates([refactor, neighbor, iface], { constraints: HYBRID_CONSTRAINTS });
    expect(ranked.map((row) => row.document.id)).toEqual(["iface", "class", "refactor"]);
  });

  test("argument orientation is symmetric", () => {
    const rel = related("rel", 0.2);
    const weakLow = weakBody("weak-low", 0);
    const weakRepeated = weakBody("weak-rep", 10);
    expect(relatedOverWeakFn(rel, weakLow)).toBe(-relatedOverWeakFn(weakLow, rel));
    expect(relatedOverWeakFn(rel, weakRepeated)).toBe(0);
    expect(relatedOverWeakFn(weakRepeated, rel)).toBe(0);
  });

  test("neutral constraint still lets a stronger related score win", () => {
    const rel = related("rel-strong", 1);
    const weak = weakBody("weak-rep", REPEATED_BODY_PHRASE_MIN);
    expect(relatedOverWeakFn(rel, weak)).toBe(0);
    expect(scoreFeatures(rel.features)).toBeGreaterThan(scoreFeatures(weak.features));
    const ranked = rankCandidates([weak, rel], { constraints: HYBRID_CONSTRAINTS });
    expect(ranked.map((row) => row.document.id)).toEqual(["rel-strong", "weak-rep"]);
    expect(lastRankStats().mode).toBe("sparse");
  });

  test("neutral constraint still lets a repeated weak-direct score win", () => {
    const rel = related("rel-weak", 0.2);
    const weak = weakBody("weak-rep", 10);
    expect(relatedOverWeakFn(rel, weak)).toBe(0);
    expect(scoreFeatures(weak.features)).toBeGreaterThan(scoreFeatures(rel.features));
    const ranked = rankCandidates([rel, weak], { constraints: HYBRID_CONSTRAINTS });
    expect(ranked.map((row) => row.document.id)).toEqual(["weak-rep", "rel-weak"]);
    expect(lastRankStats().mode).toBe("sparse");
  });

  test("unrelated constraint classes are unchanged", () => {
    const exact = hit("exact", {
      exactTitleMatch: true,
      exactTitleTokenMatch: true,
      queryCoverage: 1,
      titleCoverage: 1,
      titlePrefixQuality: 1,
      directClass: "strong",
      relevanceKind: "direct",
    });
    const rel = related("rel", 1);
    const strong = hit("strong", {
      relevanceKind: "direct",
      directClass: "strong",
      queryCoverage: 1,
      titlePrefixQuality: 0.9,
    });
    expect(compareConstraint(exact, rel, HYBRID_CONSTRAINTS).order).toBe(-1);
    expect(compareConstraint(strong, rel, HYBRID_CONSTRAINTS).order).toBe(-1);
    expect(compareConstraint(exact, rel, DEFAULT_CONSTRAINTS).order).toBe(-1);
    const repeatedTwoToken = hit("rep-2", {
      queryTokenCount: 2,
      bodyPhraseCount: 5,
      queryCoverage: 0,
      exactTitleTokenMatch: false,
      directClass: "moderate",
      relevanceKind: "direct",
    });
    const incidental = hit("incidental", {
      exactTitleTokenMatch: true,
      queryCoverage: 0.5,
      bodyPhraseCount: 0,
      directClass: "weak",
      relevanceKind: "direct",
    });
    expect(compareConstraint(repeatedTwoToken, incidental, DEFAULT_CONSTRAINTS).order).toBe(-1);
    expect(compareConstraint(repeatedTwoToken, incidental, HYBRID_CONSTRAINTS).order).toBe(-1);
  });

  test("contextual title completion outranks a stop-wrapped short-literal lead", () => {
    const contextual = hit("api", {
      contextualTitlePrefix: true,
      contextualPrefixQuality: 0.75,
      shortLiteralLeadMatch: false,
      directClass: "moderate",
      relevanceKind: "direct",
    });
    const lead = hit("appsec", {
      shortLiteralLeadMatch: true,
      contextualTitlePrefix: false,
      directClass: "moderate",
      relevanceKind: "direct",
    });
    expect(compareConstraint(contextual, lead, HYBRID_CONSTRAINTS).order).toBe(-1);
    expect(compareConstraint(lead, contextual, HYBRID_CONSTRAINTS).order).toBe(1);
  });

  test("related-over-weak-direct still applies when the weak hit also has relationship support", () => {
    const rel = related("class-vs-interface", 0.495);
    const weakHybrid = weakBody("refactoring", 0, { relationshipStrength: 0.428 });
    expect(weakHybrid.features.relevanceKind).toBe("direct");
    expect(weakHybrid.features.directClass).toBe("weak");
    expect(relatedOverWeakFn(rel, weakHybrid)).toBe(-1);
    const ranked = rankCandidates([weakHybrid, rel], { constraints: HYBRID_CONSTRAINTS });
    expect(ranked.map((row) => row.document.id)).toEqual(["class-vs-interface", "refactoring"]);
  });

  test("a weak-direct with equal-or-stronger relationship support stays unordered vs related", () => {
    const rel = related("class-vs-interface", 0.495);
    const weakHybrid = weakBody("interface", 0, { relationshipStrength: 0.512 });
    expect(relatedOverWeakFn(rel, weakHybrid)).toBe(0);
  });
});
