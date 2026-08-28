import {
  rankCandidates,
  selectTopPerBuiltinSignature,
} from "../dist/rank.js";
import {
  compareConstraint,
  DEFAULT_CONSTRAINTS,
  HYBRID_CONSTRAINTS,
} from "../dist/constraints.js";
import { pickPrimariesForExpansion } from "../dist/relationships.js";

function features(over = {}) {
  return {
    exactTitleMatch: false,
    exactTitleTokenMatch: false,
    typedSurfaceTitleMatch: false,
    titleCoverage: 0,
    queryCoverage: 0,
    titlePrefixQuality: 0,
    contextualTitlePrefix: false,
    matchedPrefixTokens: [],
    activeFinalPrefix: null,
    completedTitleToken: null,
    unmatchedTitleTokensAfter: 0,
    titleSequenceTightness: 0,
    contextualPrefixQuality: 0,
    configuredConceptMatch: false,
    morphologyMatch: false,
    typoDistance: 0,
    versionMatch: false,
    shortLiteralLeadMatch: false,
    dottedSpanComponentTitleMatch: false,
    phraseAdjacency: 0,
    bodyLexicalMatch: 0,
    titleTokenCount: 1,
    configuredFormEvidence: 0,
    canonicalKeyTitle: false,
    queryTokenCount: 1,
    normalizedQueryPhrase: "",
    matchingPhraseKey: null,
    bodyPhraseCount: 0,
    bodyPhraseFrequency: 0,
    relationshipStrength: 0,
    relationshipType: null,
    relationshipSourceId: null,
    retrievalScore: 0,
    relevanceKind: "direct",
    directClass: "none",
    ...over,
  };
}

function hit(id, over = {}) {
  return {
    document: { id, title: id },
    retrievalSources: ["test"],
    features: features(over),
  };
}

function ids(rows, n) {
  return rows.slice(0, n).map((row) => row.document.id);
}

function compactCompare(row) {
  return {
    order: row.constraintVsNext.order,
    conflict: Boolean(row.constraintVsNext.conflict),
    resolution: row.constraintVsNext.resolution,
    decisiveClass: row.constraintVsNext.decisiveClass,
    applied: row.constraintVsNext.applied,
  };
}

function expectExactPrefix(candidates, depth, constraints = DEFAULT_CONSTRAINTS) {
  const full = rankCandidates(candidates, { constraints });
  const selected = selectTopPerBuiltinSignature(candidates, depth, constraints);
  const reduced = rankCandidates(selected.candidates, { constraints });
  expect(ids(reduced, depth)).toEqual(ids(full, depth));
  expect(reduced.slice(0, depth).map((row) => row.score)).toEqual(
    full.slice(0, depth).map((row) => row.score)
  );
  return { full, reduced, selected };
}

function expectExactPrefixWithNext(candidates, depth, constraints = DEFAULT_CONSTRAINTS) {
  const full = rankCandidates(candidates, { constraints });
  const selected = selectTopPerBuiltinSignature(candidates, depth + 1, constraints);
  const reduced = rankCandidates(selected.candidates, { constraints });
  expect(ids(reduced, depth)).toEqual(ids(full, depth));
  expect(reduced.slice(0, depth).map(compactCompare)).toEqual(
    full.slice(0, depth).map(compactCompare)
  );
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, values) {
  return values[Math.floor(rng() * values.length)];
}

function randomFeatures(rng) {
  return {
    exactTitleMatch: rng() < 0.08,
    exactTitleTokenMatch: rng() < 0.35,
    typedSurfaceTitleMatch: rng() < 0.4,
    titleCoverage: pick(rng, [0, 0.5, 0.8, 1]),
    queryCoverage: pick(rng, [0, 0.25, 0.6667, 1]),
    titlePrefixQuality: pick(rng, [0, 0.3, 0.5, 0.9]),
    contextualTitlePrefix: rng() < 0.12,
    contextualPrefixQuality: pick(rng, [0, 0.25, 0.5, 1]),
    configuredConceptMatch: pick(rng, [false, false, "form", "key-in-title"]),
    morphologyMatch: rng() < 0.25,
    typoDistance: pick(rng, [0, 0, 1, 2]),
    versionMatch: pick(rng, [false, false, "compact-weak", "dotted-weak", "compact-dotted", "dotted"]),
    shortLiteralLeadMatch: rng() < 0.12,
    dottedSpanComponentTitleMatch: rng() < 0.1,
    phraseAdjacency: pick(rng, [0, 0.5, 1]),
    bodyLexicalMatch: pick(rng, [0, 0.5, 1]),
    titleTokenCount: 1 + Math.floor(rng() * 8),
    configuredFormEvidence: pick(rng, [0, 0.5, 1]),
    canonicalKeyTitle: rng() < 0.08,
    queryTokenCount: pick(rng, [1, 2, 3]),
    bodyPhraseCount: pick(rng, [0, 0, 1, 2, 4]),
    relationshipStrength: rng(),
    retrievalScore: rng() * 2,
    relevanceKind: pick(rng, ["direct", "direct", "related"]),
    directClass: pick(rng, ["none", "weak", "moderate", "strong"]),
  };
}

describe("top-R per builtin constraint signature", () => {
  test("many candidates in one signature retain score then document.id prefixes", () => {
    const candidates = [];
    for (let i = 0; i < 250; i += 1) {
      candidates.push(hit(`d${String(249 - i).padStart(3, "0")}`, {
        bodyLexicalMatch: 1,
        retrievalScore: i % 7,
        directClass: "weak",
      }));
    }
    for (const depth of [1, 3, 5, 10, 50]) {
      const { selected } = expectExactPrefix(candidates, depth);
      expect(selected.stats.signatures).toBe(1);
      expect(selected.stats.retained).toBe(depth);
      expectExactPrefixWithNext(candidates, depth);
    }
  });

  test("malformed queryTokenCount proves generic order-free reduction is invalid", () => {
    const candidates = [
      hit("s-low", {
        queryTokenCount: 1,
        typedSurfaceTitleMatch: true,
        retrievalScore: 1,
      }),
      hit("t", {
        queryTokenCount: 2,
        typedSurfaceTitleMatch: false,
        retrievalScore: 10,
      }),
      hit("s-high", {
        queryTokenCount: 1,
        typedSurfaceTitleMatch: true,
        retrievalScore: 5,
      }),
    ];
    const full = rankCandidates(candidates);
    expect(ids(full, 3)).toEqual(["s-high", "s-low", "t"]);

    const selected = selectTopPerBuiltinSignature(candidates, 1);
    expect(selected.candidates.map((row) => row.document.id)).toEqual(["s-high", "t"]);
    expect(ids(rankCandidates(selected.candidates), 1)).toEqual(["s-high"]);

    // A stable-filter implementation would reverse first-seen bucket order
    // after dropping s-low and would incorrectly make t the winner.
    expect(ids(rankCandidates([candidates[1], selected.candidates[0]]), 1)).toEqual(["t"]);
  });

  test("representatives use the ranker's rounded score before document.id", () => {
    const candidates = [
      hit("z-higher-unrounded", {
        bodyLexicalMatch: 1,
        retrievalScore: 0.00000049,
      }),
      hit("a-lower-unrounded", {
        bodyLexicalMatch: 1,
        retrievalScore: 0.0000004,
      }),
    ];
    const expected = rankCandidates(candidates);
    expect(expected.map((row) => row.document.id)).toEqual([
      "a-lower-unrounded",
      "z-higher-unrounded",
    ]);
    expect(selectTopPerBuiltinSignature(candidates, 1).candidates.map((row) => row.document.id))
      .toEqual(["a-lower-unrounded"]);
  });

  test("incomparable, dominated, stronger/weaker, and same-class-conflict signatures preserve prefixes", () => {
    const candidates = [];
    for (let i = 0; i < 40; i += 1) {
      candidates.push(hit(`exact-${String(i).padStart(2, "0")}`, {
        exactTitleMatch: true,
        queryCoverage: 1,
        titleCoverage: 1,
        titlePrefixQuality: 1,
        titleTokenCount: 2,
        directClass: "strong",
        retrievalScore: i / 10,
      }));
      candidates.push(hit(`context-${String(i).padStart(2, "0")}`, {
        contextualTitlePrefix: true,
        contextualPrefixQuality: 1,
        queryCoverage: 0.5,
        titlePrefixQuality: 0.5,
        directClass: "moderate",
        retrievalScore: (40 - i) / 10,
      }));
      candidates.push(hit(`weak-${String(i).padStart(2, "0")}`, {
        bodyLexicalMatch: 1,
        directClass: "weak",
        retrievalScore: i / 20,
      }));
      candidates.push(hit(`related-${String(i).padStart(2, "0")}`, {
        relevanceKind: "related",
        directClass: "none",
        relationshipStrength: i / 40,
      }));
    }
    for (const constraints of [DEFAULT_CONSTRAINTS, HYBRID_CONSTRAINTS]) {
      for (const depth of [1, 3, 5, 10]) {
        expectExactPrefix(candidates, depth, constraints);
        expectExactPrefixWithNext(candidates, depth, constraints);
      }
    }
  });

  test("builtin same-class conflicts stay unordered and preserve score/id interleaving", () => {
    const candidates = [
      hit("coverage-low", {
        queryTokenCount: 1,
        queryCoverage: 1,
        titleCoverage: 1,
        titlePrefixQuality: 1,
        typedSurfaceTitleMatch: false,
        retrievalScore: 1,
      }),
      hit("surface-high", {
        queryTokenCount: 1,
        queryCoverage: 0.2,
        typedSurfaceTitleMatch: true,
        retrievalScore: 8,
      }),
      hit("coverage-high", {
        queryTokenCount: 1,
        queryCoverage: 1,
        titleCoverage: 1,
        titlePrefixQuality: 1,
        typedSurfaceTitleMatch: false,
        retrievalScore: 6,
      }),
    ];
    const cmp = compareConstraint(candidates[0], candidates[1], DEFAULT_CONSTRAINTS);
    expect(cmp).toMatchObject({
      order: 0,
      conflict: true,
      resolution: "unordered-same-class-conflict",
      decisiveClass: "strong",
    });
    expectExactPrefix(candidates, 2);
    expect(ids(rankCandidates(candidates), 3)).toEqual([
      "coverage-high",
      "surface-high",
      "coverage-low",
    ]);
  });

  test("builtin signature cycles remain exact after per-signature prefixes", () => {
    const cycle = [
      {
        exactTitleTokenMatch: true,
        typedSurfaceTitleMatch: true,
        queryCoverage: 1,
        titleCoverage: 0.8,
        contextualTitlePrefix: true,
        contextualPrefixQuality: 0.7,
        configuredConceptMatch: "form",
        morphologyMatch: true,
        dottedSpanComponentTitleMatch: true,
        bodyLexicalMatch: 1,
        titleTokenCount: 4,
        canonicalKeyTitle: true,
        directClass: "strong",
      },
      {
        typedSurfaceTitleMatch: true,
        queryCoverage: 1,
        titleCoverage: 1,
        contextualTitlePrefix: true,
        contextualPrefixQuality: 0.7,
        morphologyMatch: true,
        versionMatch: "dotted-weak",
        dottedSpanComponentTitleMatch: true,
        bodyLexicalMatch: 0.5,
        titleTokenCount: 1,
        canonicalKeyTitle: true,
        directClass: "strong",
      },
      {
        typedSurfaceTitleMatch: true,
        queryCoverage: 1,
        titleCoverage: 1,
        titlePrefixQuality: 1,
        contextualTitlePrefix: true,
        contextualPrefixQuality: 0.7,
        configuredConceptMatch: "form",
        bodyLexicalMatch: 0.5,
        titleTokenCount: 3,
        configuredFormEvidence: 1,
        canonicalKeyTitle: true,
        directClass: "strong",
      },
    ];
    const candidates = [];
    for (let sig = 0; sig < cycle.length; sig += 1) {
      for (let i = 0; i < 30; i += 1) {
        candidates.push(hit(`s${sig}-${String(i).padStart(2, "0")}`, {
          ...cycle[sig],
          retrievalScore: (i % 9) / 10,
        }));
      }
    }
    const full = rankCandidates(candidates);
    expect(full[0].constraintMeta.cycles.length).toBeGreaterThan(0);
    for (const depth of [1, 3, 10]) {
      expectExactPrefix(candidates, depth);
      expectExactPrefixWithNext(candidates, depth);
    }
  });

  test("deterministic property mixtures preserve top R for default and hybrid constraints", () => {
    const rng = mulberry32(0x52505245);
    for (let round = 0; round < 50; round += 1) {
      const candidates = [];
      const queryTokenCount = pick(rng, [1, 2, 3]);
      for (let i = 0; i < 80; i += 1) {
        candidates.push(hit(`r${round}-${String(i).padStart(3, "0")}`, {
          ...randomFeatures(rng),
          queryTokenCount,
        }));
      }
      for (const constraints of [DEFAULT_CONSTRAINTS, HYBRID_CONSTRAINTS]) {
        for (const depth of [1, 3, 5, 10]) {
          expectExactPrefix(candidates, depth, constraints);
          expectExactPrefixWithNext(candidates, depth, constraints);
        }
      }
    }
  });

  test("custom constraints fail closed to the complete candidate set", () => {
    const custom = [{
      id: "custom-id",
      invariant: "test",
      class: "strong",
      fn: (a, b) => a.document.id < b.document.id ? -1 : a.document.id > b.document.id ? 1 : 0,
    }];
    const candidates = [hit("c"), hit("a"), hit("b")];
    const selected = selectTopPerBuiltinSignature(candidates, 1, custom);
    expect(selected.candidates).toHaveLength(candidates.length);
    expect(selected.stats.fallback).toBe("custom-constraints");
    expect(ids(rankCandidates(selected.candidates, { constraints: custom }), 3)).toEqual(["a", "b", "c"]);
  });

  test("relationship top1/top-n primary selection uses exact signature representatives", () => {
    const candidates = [];
    for (let i = 0; i < 80; i += 1) {
      candidates.push(hit(`exact-${String(i).padStart(3, "0")}`, {
        exactTitleMatch: true,
        queryCoverage: 1,
        titleCoverage: 1,
        directClass: "strong",
        retrievalScore: i / 10,
      }));
      candidates.push(hit(`prefix-${String(i).padStart(3, "0")}`, {
        queryCoverage: 1,
        titlePrefixQuality: 0.6,
        directClass: "strong",
        retrievalScore: (80 - i) / 10,
      }));
    }
    const expected = rankCandidates(candidates);
    expect(ids(pickPrimariesForExpansion(candidates), 1)).toEqual(ids(expected, 1));
    expect(ids(pickPrimariesForExpansion(candidates, { sourcePolicy: "top-n-strong", n: 5 }), 5))
      .toEqual(ids(expected, 5));
    expect(ids(pickPrimariesForExpansion(candidates, { sourcePolicy: "all-strong" }), candidates.length))
      .toEqual(ids(expected, candidates.length));
  });
});
