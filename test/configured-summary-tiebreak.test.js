/**
 * Configured summary vs body-only is recorded on features, not consumed in
 * ranking. The rejected H8 categorical constraint stays gone.
 */
import { HYBRID_CONSTRAINTS, compareConstraint, DEFAULT_CONSTRAINTS } from "../dist/constraints.js";
import { rankCandidates, scoreFeatures } from "../dist/rank.js";
import { compareScoreThenWeakBodyThenId } from "../dist/rankTieBreak.js";

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
      bodyLexicalMatch: 1,
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
      directClass: "weak",
      configuredConceptFieldEvidence: { title: false, summary: false, body: false },
      ...over,
    },
  };
}

describe("configured summary provenance is not a ranking consumer", () => {
  test("H8 categorical constraint is gone", () => {
    expect(HYBRID_CONSTRAINTS.find((c) => c.id === "configured-summary-over-body-mention")).toBeUndefined();
    expect(DEFAULT_CONSTRAINTS.find((c) => c.id === "configured-summary-over-body-mention")).toBeUndefined();
  });

  test("equal scores: document id wins even when summary vs body-only differ", () => {
    const summary = hit("zz-summary", {
      configuredConceptFieldEvidence: { title: false, summary: "key", body: "key" },
    });
    const bodyOnly = hit("aa-body", {
      configuredConceptFieldEvidence: { title: false, summary: false, body: "key" },
    });
    expect(scoreFeatures(summary.features)).toBe(scoreFeatures(bodyOnly.features));
    expect(compareConstraint(summary, bodyOnly, HYBRID_CONSTRAINTS).order).toBe(0);
    expect(compareScoreThenWeakBodyThenId(summary, bodyOnly)).toBeGreaterThan(0);
    const ranked = rankCandidates([bodyOnly, summary], { constraints: HYBRID_CONSTRAINTS });
    expect(ranked.map((row) => row.document.id)).toEqual(["aa-body", "zz-summary"]);
    expect(ranked[0].score).toBe(ranked[1].score);
  });

  test("unequal scores: higher body-adjacency score is not reversed", () => {
    const summary = hit("sum", {
      configuredConceptFieldEvidence: { title: false, summary: "key", body: "key" },
      phraseAdjacency: 0,
    });
    const bodyOnly = hit("body", {
      configuredConceptFieldEvidence: { title: false, summary: false, body: "key" },
      phraseAdjacency: 0.5,
    });
    const summaryScore = scoreFeatures(summary.features);
    const bodyScore = scoreFeatures(bodyOnly.features);
    expect(bodyScore).toBeGreaterThan(summaryScore);
    expect(compareConstraint(summary, bodyOnly, HYBRID_CONSTRAINTS).order).toBe(0);
    const ranked = rankCandidates([summary, bodyOnly], { constraints: HYBRID_CONSTRAINTS });
    expect(ranked.map((row) => row.document.id)).toEqual(["body", "sum"]);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  test("related still outranks a weak summary mention", () => {
    const rel = hit("rel", {
      relevanceKind: "related",
      directClass: "none",
      bodyLexicalMatch: 0,
      relationshipStrength: 0.495,
      configuredConceptFieldEvidence: { title: false, summary: false, body: false },
    });
    const summary = hit("sum", {
      configuredConceptFieldEvidence: { title: false, summary: "key", body: "key" },
    });
    const ranked = rankCandidates([summary, rel], { constraints: HYBRID_CONSTRAINTS });
    expect(ranked.map((row) => row.document.id)).toEqual(["rel", "sum"]);
  });
});
