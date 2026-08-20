import { compareConstraint, detectConstraintCycles, DEFAULT_CONSTRAINTS } from "../src/constraints.js";
import {
  TWO_THIRDS_QUERY_COVERAGE,
  REPEATED_BODY_PHRASE_MIN,
  FULL_QUERY_COVERAGE,
} from "../src/evidencePolicy.js";

function hit(id, over = {}) {
  return {
    document: { id, title: id },
    features: {
      exactTitleMatch: false,
      exactTitleTokenMatch: false,
      titleCoverage: 0,
      queryCoverage: 0,
      titlePrefixQuality: 0,
      contextualTitlePrefix: false,
      contextualPrefixQuality: 0,
      configuredEquivalenceMatch: false,
      morphologyMatch: false,
      typedSurfaceTitleMatch: false,
      typoDistance: 0,
      versionMatch: false,
      shortLiteralLeadMatch: false,
      phraseAdjacency: 0,
      bodyLexicalMatch: 0,
      titleTokenCount: 3,
      expansionEvidence: 0,
      canonicalKeyTitle: false,
      queryTokenCount: 2,
      bodyPhraseCount: 0,
      relevanceKind: "direct",
      directClass: "none",
      ...over,
    },
  };
}

const exactTitle = hit("exact-title", {
  exactTitleMatch: true,
  exactTitleTokenMatch: true,
  queryCoverage: 1,
  titleCoverage: 1,
  titlePrefixQuality: 1,
  directClass: "strong",
});

const contextualTight = hit("contextual-tight", {
  contextualTitlePrefix: true,
  contextualPrefixQuality: 1,
  queryCoverage: 0.5,
  titlePrefixQuality: 0.4,
  directClass: "moderate",
});

const contextualLoose = hit("contextual-loose", {
  contextualTitlePrefix: true,
  contextualPrefixQuality: 0.4,
  unmatchedTitleTokensAfter: 2,
  queryCoverage: 0.5,
  directClass: "moderate",
});

const configuredKey = hit("configured-key", {
  configuredEquivalenceMatch: "key-in-title",
  canonicalKeyTitle: true,
  queryCoverage: 1,
  directClass: "strong",
});

const incidentalTitle = hit("incidental-title", {
  exactTitleTokenMatch: true,
  queryCoverage: 0.5,
  bodyPhraseCount: 0,
  directClass: "weak",
});

const weakBody = hit("weak-body", {
  bodyLexicalMatch: 1,
  queryCoverage: 0,
  exactTitleTokenMatch: false,
  directClass: "weak",
});

const repeatedPhrase = hit("repeated-phrase", {
  queryTokenCount: 2,
  bodyPhraseCount: 5,
  queryCoverage: 0,
  exactTitleTokenMatch: false,
  directClass: "moderate",
});

const fullCoverage = hit("full-coverage", {
  queryCoverage: 1,
  titleCoverage: 0.9,
  titlePrefixQuality: 0.5,
  exactTitleMatch: false,
  directClass: "strong",
});

const versionExact = hit("version-exact", {
  versionMatch: "dotted",
  queryCoverage: 1,
  directClass: "strong",
});

describe("adversarial constraint pairs", () => {
  test("exact title beats contextual prefix when they conflict", () => {
    const cmp = compareConstraint(exactTitle, contextualTight, DEFAULT_CONSTRAINTS);
    expect(cmp.order).toBe(-1);
    expect(cmp.applied.some((r) => r.id === "exact-title-over-non-exact" && r.result === "A>B")).toBe(true);
    expect(cmp.applied.some((r) => r.id === "contextual-title-prefix-over-unaligned" && r.result === "B>A")).toBe(
      false
    );
  });

  test("configured equivalence is not blindly demoted by contextual prefix", () => {
    const cmp = compareConstraint(configuredKey, contextualTight, DEFAULT_CONSTRAINTS);
    expect(cmp.applied.some((r) => r.id === "contextual-title-prefix-over-unaligned" && r.result === "B>A")).toBe(
      false
    );
    expect(cmp.order).not.toBe(1);
  });

  test("contextual prefix beats incidental title-token overlap", () => {
    const cmp = compareConstraint(contextualTight, incidentalTitle, DEFAULT_CONSTRAINTS);
    expect(cmp.order).toBe(-1);
    expect(cmp.applied.some((r) => r.id === "contextual-title-prefix-over-unaligned")).toBe(true);
  });

  test("contextual prefix beats a weak body-only hit", () => {
    const cmp = compareConstraint(contextualTight, weakBody, DEFAULT_CONSTRAINTS);
    expect(cmp.order).toBe(-1);
  });

  test("repeated body phrase beats incidental title token and not strong title evidence", () => {
    expect(compareConstraint(repeatedPhrase, incidentalTitle, DEFAULT_CONSTRAINTS).order).toBe(-1);
    expect(compareConstraint(repeatedPhrase, exactTitle, DEFAULT_CONSTRAINTS).order).toBe(1);
    expect(compareConstraint(repeatedPhrase, fullCoverage, DEFAULT_CONSTRAINTS).order).not.toBe(-1);
  });

  test("repeated phrase outranks weak/incidental evidence only", () => {
    expect(compareConstraint(repeatedPhrase, weakBody, DEFAULT_CONSTRAINTS).order).toBe(-1);
    expect(compareConstraint(repeatedPhrase, incidentalTitle, DEFAULT_CONSTRAINTS).order).toBe(-1);
    const moderateTitle = hit("moderate-title", {
      queryCoverage: TWO_THIRDS_QUERY_COVERAGE,
      titlePrefixQuality: 0.5,
      exactTitleTokenMatch: true,
      bodyPhraseCount: 0,
      directClass: "moderate",
    });
    expect(compareConstraint(repeatedPhrase, moderateTitle, DEFAULT_CONSTRAINTS).order).not.toBe(-1);
    const strongTitle = hit("strong-title", {
      queryCoverage: FULL_QUERY_COVERAGE,
      titlePrefixQuality: 0.8,
      exactTitleTokenMatch: true,
      bodyPhraseCount: 0,
      directClass: "strong",
    });
    expect(compareConstraint(repeatedPhrase, strongTitle, DEFAULT_CONSTRAINTS).order).not.toBe(-1);
    expect(compareConstraint(repeatedPhrase, contextualTight, DEFAULT_CONSTRAINTS).order).not.toBe(-1);
    expect(compareConstraint(repeatedPhrase, exactTitle, DEFAULT_CONSTRAINTS).order).toBe(1);
  });

  test("tighter contextual prefix beats looser contextual prefix", () => {
    expect(compareConstraint(contextualTight, contextualLoose, DEFAULT_CONSTRAINTS).order).toBe(-1);
  });

  test("version exact evidence is not overturned by unrelated contextual prefix", () => {
    const cmp = compareConstraint(versionExact, contextualTight, DEFAULT_CONSTRAINTS);
    expect(cmp.applied.some((r) => r.id === "contextual-title-prefix-over-unaligned" && r.result === "B>A")).toBe(
      false
    );
    expect(cmp.order).not.toBe(1);
  });

  test("H3 exact-surface-over-lemma still prefers a typed title token", () => {
    const surface = hit("surface", {
      typedSurfaceTitleMatch: true,
      exactTitleTokenMatch: false,
      morphologyMatch: true,
      queryTokenCount: 1,
      queryCoverage: 1,
      directClass: "moderate",
    });
    const lemmaOnly = hit("lemma-only", {
      typedSurfaceTitleMatch: false,
      exactTitleTokenMatch: false,
      morphologyMatch: true,
      queryTokenCount: 1,
      queryCoverage: 1,
      directClass: "moderate",
    });
    const cmp = compareConstraint(surface, lemmaOnly, DEFAULT_CONSTRAINTS);
    expect(cmp.applied.some((r) => r.id === "exact-surface-over-lemma-only" && r.result === "A>B")).toBe(true);
    expect(cmp.order).toBe(-1);
  });

  test("H3 exact-surface-over-lemma does not reorder multi-token queries", () => {
    const surface = hit("surface", {
      typedSurfaceTitleMatch: true,
      morphologyMatch: true,
      queryTokenCount: 2,
      queryCoverage: 0.5,
      directClass: "moderate",
    });
    const lemmaOnly = hit("lemma-only", {
      typedSurfaceTitleMatch: false,
      morphologyMatch: true,
      queryTokenCount: 2,
      queryCoverage: 0.5,
      directClass: "moderate",
    });
    const cmp = compareConstraint(surface, lemmaOnly, DEFAULT_CONSTRAINTS);
    expect(cmp.applied.some((r) => r.id === "exact-surface-over-lemma-only")).toBe(false);
  });

  test("no absolute same-class pairwise conflicts among the adversarial set", () => {
    const candidates = [
      exactTitle,
      contextualTight,
      contextualLoose,
      configuredKey,
      incidentalTitle,
      weakBody,
      repeatedPhrase,
      fullCoverage,
      versionExact,
    ];
    const diagnosis = detectConstraintCycles(candidates, DEFAULT_CONSTRAINTS);
    expect(diagnosis.cycles).toEqual([]);
    const sameClassAbsoluteConflicts = diagnosis.pairReports.filter(
      (p) =>
        p.decisiveClass === "absolute" &&
        p.conflict &&
        p.resolution === "unordered-same-class-conflict"
    );
    expect(sameClassAbsoluteConflicts).toEqual([]);

    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const ab = compareConstraint(candidates[i], candidates[j], DEFAULT_CONSTRAINTS);
        const ba = compareConstraint(candidates[j], candidates[i], DEFAULT_CONSTRAINTS);
        if (ab.conflict || ba.conflict) continue;
        if (ab.order === 0 && ba.order === 0) continue;
        expect(ab.order).toBe(-ba.order);
      }
    }
  });
});

describe("incidental title coverage boundary", () => {
  test("1/2 coverage is incidental; 2/3 and full coverage are not", () => {
    const phrase = hit("phrase", {
      queryTokenCount: 2,
      bodyPhraseCount: REPEATED_BODY_PHRASE_MIN,
      directClass: "moderate",
    });
    const half = hit("half", {
      exactTitleTokenMatch: true,
      queryCoverage: 1 / 2,
      bodyPhraseCount: 0,
      directClass: "weak",
    });
    const twoThirds = hit("two-thirds", {
      exactTitleTokenMatch: true,
      queryCoverage: TWO_THIRDS_QUERY_COVERAGE,
      bodyPhraseCount: 0,
      directClass: "moderate",
    });
    const full = hit("full", {
      exactTitleTokenMatch: true,
      queryCoverage: FULL_QUERY_COVERAGE,
      titlePrefixQuality: 1,
      bodyPhraseCount: 0,
      directClass: "strong",
    });
    expect(compareConstraint(phrase, half, DEFAULT_CONSTRAINTS).order).toBe(-1);
    expect(
      compareConstraint(phrase, twoThirds, DEFAULT_CONSTRAINTS).applied.some(
        (r) => r.id === "repeated-phrase-over-weak-direct"
      )
    ).toBe(false);
    expect(
      compareConstraint(phrase, full, DEFAULT_CONSTRAINTS).applied.some(
        (r) => r.id === "repeated-phrase-over-weak-direct"
      )
    ).toBe(false);
  });
});
