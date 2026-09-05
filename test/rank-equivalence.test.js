/**
 * Differential ranking harness: production rankCandidates vs the frozen
 * all-pairs oracle (rankCandidatesPairwise). Fail closed on any public
 * semantic difference. Do not update expected results to match a new ranker.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchEngine, morphology } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/relationships/configuredConcepts.js";
import { attachLexicalFrequency } from "../tools/search-lexical/index.js";
import { DEFAULT_CONSTRAINTS, HYBRID_CONSTRAINTS, compareConstraint } from "../dist/ranking/constraints.js";
import { rankCandidates, rankCandidatesAsync, lastRankStats } from "../dist/ranking/rank.js";
import { rankCandidatesPairwise, rankCandidatesPairwiseAsync } from "../build/test/oracles/rankOracle.js";
import { constraintSignature } from "../dist/ranking/rankSignature.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(ROOT, "fixtures", "software-land");

function loadJson(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));
}

function blankFeatures(over = {}) {
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
    ordinaryEquivalenceBodyMatch: false,
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
  };
}

function hit(id, over = {}) {
  return { document: { id, title: id }, features: blankFeatures(over) };
}

function publicRankSurface(ranked) {
  return {
    ids: ranked.map((row) => row.document.id),
    ranks: ranked.map((row) => row.rank),
    scores: ranked.map((row) => row.score),
    cycles: ranked[0]?.constraintMeta?.cycles ?? [],
    conflictCount: ranked[0]?.constraintMeta?.conflictCount ?? 0,
    constraintsVsNext: ranked.map((row) => ({
      order: row.constraintVsNext?.order ?? 0,
      conflict: Boolean(row.constraintVsNext?.conflict),
      resolution: row.constraintVsNext?.resolution ?? "unordered",
      decisiveClass: row.constraintVsNext?.decisiveClass,
      applied: (row.constraintVsNext?.applied || []).map((a) => ({
        id: a.id,
        invariant: a.invariant,
        class: a.class,
        result: a.result,
      })),
    })),
  };
}

function expectEquivalent(actual, expected, label) {
  const a = publicRankSurface(actual);
  const b = publicRankSurface(expected);
  expect({ label, ...a }).toEqual({ label, ...b });
}

function rankBoth(candidates, constraints = DEFAULT_CONSTRAINTS) {
  const expected = rankCandidatesPairwise(candidates, { constraints });
  const actual = rankCandidates(candidates, { constraints });
  expectEquivalent(actual, expected);
  return actual;
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

function pick(rng, items) {
  return items[Math.floor(rng() * items.length)];
}

function randomFeatures(rng) {
  const queryCoverage = pick(rng, [0, 0.2, 0.5, 0.7, 0.999, 1]);
  const titleCoverage = pick(rng, [0, 0.4, 0.79, 0.8, 1]);
  const contextual = rng() < 0.35;
  return {
    exactTitleMatch: rng() < 0.15,
    exactTitleTokenMatch: rng() < 0.35,
    typedSurfaceTitleMatch: rng() < 0.3,
    titleCoverage,
    queryCoverage,
    titlePrefixQuality: pick(rng, [0, 0.2, 0.5, 0.9]),
    contextualTitlePrefix: contextual,
    contextualPrefixQuality: contextual ? Number(rng().toFixed(4)) : 0,
    configuredConceptMatch: pick(rng, [false, false, "key-in-title", "form"]),
    versionMatch: pick(rng, [false, false, "dotted", "compact-dotted", "compact-weak", "dotted-weak"]),
    shortLiteralLeadMatch: rng() < 0.2,
    dottedSpanComponentTitleMatch: rng() < 0.15,
    titleTokenCount: 1 + Math.floor(rng() * 8),
    canonicalKeyTitle: rng() < 0.1,
    queryTokenCount: pick(rng, [1, 1, 2, 3]),
    bodyPhraseCount: pick(rng, [0, 0, 1, 2, 4]),
    retrievalScore: rng() * 2,
    relevanceKind: pick(rng, ["direct", "direct", "related"]),
    directClass: pick(rng, ["none", "weak", "moderate", "strong"]),
  };
}

function cycleAmong(ids) {
  const order = Object.fromEntries(ids.map((id, i) => [id, i]));
  const n = ids.length;
  return (a, b) => {
    if (!(a.document.id in order) || !(b.document.id in order)) return 0;
    const d = (order[b.document.id] - order[a.document.id] + n) % n;
    if (d === 1) return -1;
    if (d === n - 1) return 1;
    return 0;
  };
}

describe("ranking equivalence oracle", () => {
  test("empty and singleton match", () => {
    expect(rankCandidates([])).toEqual(rankCandidatesPairwise([]));
    rankBoth([hit("only", { exactTitleMatch: true })]);
  });

  test("identical signatures stay score+id ordered and conflict-free", () => {
    const ranked = rankBoth([
      hit("c", { queryCoverage: 0.2, retrievalScore: 1 }),
      hit("a", { queryCoverage: 0.2, retrievalScore: 3 }),
      hit("b", { queryCoverage: 0.2, retrievalScore: 3 }),
    ]);
    expect(ranked.map((row) => row.document.id)).toEqual(["a", "b", "c"]);
    expect(ranked[0].constraintMeta.conflictCount).toBe(0);
    expect(ranked[0].constraintMeta.cycles).toEqual([]);
  });

  test("weak single-token body pack ties break on bodyPhraseCount before id", () => {
    const ranked = rankBoth([
      hit("a-rare", {
        queryTokenCount: 1,
        directClass: "weak",
        bodyLexicalMatch: 1,
        bodyPhraseCount: 1,
        queryCoverage: 0,
      }),
      hit("z-common", {
        queryTokenCount: 1,
        directClass: "weak",
        bodyLexicalMatch: 1,
        bodyPhraseCount: 8,
        queryCoverage: 0,
      }),
    ]);
    expect(ranked.map((row) => row.document.id)).toEqual(["z-common", "a-rare"]);
    expect(ranked[0].score).toBe(ranked[1].score);
  });

  test("one-query equal signatures are a directional builtin congruence", () => {
    const rng = mulberry32(0x5349474e);
    for (const constraints of [DEFAULT_CONSTRAINTS, HYBRID_CONSTRAINTS]) {
      for (let i = 0; i < 100; i += 1) {
        const queryTokenCount = pick(rng, [1, 2, 3]);
        const shared = { ...randomFeatures(rng), queryTokenCount };
        const a = hit(`a-${i}`, { ...shared, retrievalScore: 0.1 });
        const b = hit(`b-${i}`, { ...shared, retrievalScore: 9 });
        const x = hit(`x-${i}`, { ...randomFeatures(rng), queryTokenCount });

        expect(constraintSignature(a.features)).toBe(constraintSignature(b.features));
        expect(compareConstraint(a, x, constraints)).toEqual(compareConstraint(b, x, constraints));
        expect(compareConstraint(x, a, constraints)).toEqual(compareConstraint(x, b, constraints));
      }
    }
  });

  test("exact title outranks non-exact; same-class remains unordered among exacts", () => {
    rankBoth([
      hit("plain", { exactTitleMatch: false, queryCoverage: 1, titlePrefixQuality: 0.9 }),
      hit("exact", { exactTitleMatch: true, queryCoverage: 1, titlePrefixQuality: 0.9 }),
    ]);
    rankBoth([
      hit("a-exact", { exactTitleMatch: true, shortLiteralLeadMatch: true }),
      hit("b-exact", { exactTitleMatch: true, shortLiteralLeadMatch: false }),
    ]);
  });

  test("direct / related / weak classes and hybrid constraints", () => {
    const cands = [
      hit("strong", {
        relevanceKind: "direct",
        directClass: "strong",
        queryCoverage: 1,
        titlePrefixQuality: 0.9,
      }),
      hit("related", { relevanceKind: "related", directClass: "none", relationshipStrength: 1 }),
      hit("weak", { relevanceKind: "direct", directClass: "weak", queryCoverage: 0.2 }),
    ];
    rankBoth(cands, DEFAULT_CONSTRAINTS);
    rankBoth(cands, HYBRID_CONSTRAINTS);
  });

  test("related vs repeated weak-direct stays sparse-equivalent and score-decided", () => {
    rankBoth(
      [
        hit("related-high", {
          relevanceKind: "related",
          directClass: "none",
          relationshipStrength: 1,
          bodyPhraseCount: 0,
        }),
        hit("weak-repeated", {
          relevanceKind: "direct",
          directClass: "weak",
          bodyLexicalMatch: 1,
          bodyPhraseCount: 10,
          queryCoverage: 0,
        }),
      ],
      HYBRID_CONSTRAINTS
    );
    rankBoth(
      [
        hit("related-low", {
          relevanceKind: "related",
          directClass: "none",
          relationshipStrength: 0.2,
          bodyPhraseCount: 0,
        }),
        hit("weak-repeated", {
          relevanceKind: "direct",
          directClass: "weak",
          bodyLexicalMatch: 1,
          bodyPhraseCount: 10,
          queryCoverage: 0,
        }),
      ],
      HYBRID_CONSTRAINTS
    );
  });

  test("equivalence-backed weak-direct exemption is directional and sparse-safe", () => {
    const related = hit("related", {
      relevanceKind: "related",
      directClass: "none",
      relationshipStrength: 1,
    });
    const weak = hit("weak", {
      relevanceKind: "direct",
      directClass: "weak",
      bodyLexicalMatch: 1,
      queryCoverage: 0,
    });
    const ordinary = hit("ordinary-equivalence", {
      relevanceKind: "direct",
      directClass: "weak",
      bodyLexicalMatch: 1,
      queryCoverage: 0,
      ordinaryEquivalenceBodyMatch: true,
    });

    const firing = compareConstraint(related, weak, HYBRID_CONSTRAINTS);
    expect(firing.order).toBe(-1);
    expect(firing.applied.map((row) => row.id)).toContain("related-over-weak-direct");

    const neutral = compareConstraint(related, ordinary, HYBRID_CONSTRAINTS);
    expect(neutral.order).toBe(0);
    expect(neutral.applied.map((row) => row.id)).not.toContain("related-over-weak-direct");
    expect(constraintSignature(weak.features)).not.toBe(constraintSignature(ordinary.features));

    rankBoth([related, ordinary], HYBRID_CONSTRAINTS);
    rankBoth([ordinary, related], HYBRID_CONSTRAINTS);
  });

  test("full-body multi-concept over weak subset stays sparse-equivalent", () => {
    rankBoth(
      [
        hit("full-body", {
          relevanceKind: "direct",
          directClass: "weak",
          coverageConceptCount: 2,
          bodyLexicalMatch: 1,
          lexicalConceptCoverage: 1,
          queryCoverage: 0,
        }),
        hit("subset", {
          relevanceKind: "direct",
          directClass: "weak",
          coverageConceptCount: 2,
          bodyLexicalMatch: 0.5,
          lexicalConceptCoverage: 0.5,
          queryCoverage: 0.5,
          exactTitleTokenMatch: true,
        }),
      ],
      HYBRID_CONSTRAINTS
    );
    rankBoth(
      [
        hit("split-union", {
          relevanceKind: "direct",
          directClass: "weak",
          coverageConceptCount: 2,
          bodyLexicalMatch: 0.5,
          lexicalConceptCoverage: 1,
          queryCoverage: 0.5,
        }),
        hit("full-body", {
          relevanceKind: "direct",
          directClass: "weak",
          coverageConceptCount: 2,
          bodyLexicalMatch: 1,
          lexicalConceptCoverage: 1,
          queryCoverage: 0,
        }),
      ],
      HYBRID_CONSTRAINTS
    );
  });

  test("contextual prefix, coverage, surface/lemma, version, dotted span, title length, short literal", () => {
    rankBoth([
      hit("ctx-hi", {
        contextualTitlePrefix: true,
        contextualPrefixQuality: 0.9,
        queryCoverage: 0.5,
        directClass: "weak",
      }),
      hit("ctx-lo", {
        contextualTitlePrefix: true,
        contextualPrefixQuality: 0.2,
        queryCoverage: 0.5,
        directClass: "weak",
      }),
      hit("weak-body", { directClass: "weak", queryCoverage: 0.1, relevanceKind: "direct" }),
      hit("full", { queryCoverage: 0.999, titlePrefixQuality: 0.6, titleCoverage: 0.9, titleTokenCount: 4 }),
      hit("full-short", { queryCoverage: 0.999, titlePrefixQuality: 0.6, titleCoverage: 0.9, titleTokenCount: 2 }),
      hit("partial", { queryCoverage: 0.4, titlePrefixQuality: 0.2, exactTitleMatch: false }),
      hit("surface", { queryTokenCount: 1, typedSurfaceTitleMatch: true, configuredConceptMatch: false }),
      hit("lemma", { queryTokenCount: 1, typedSurfaceTitleMatch: false, configuredConceptMatch: false }),
      hit("ver-strong", { versionMatch: "dotted" }),
      hit("ver-weak", { versionMatch: "compact-weak" }),
      hit("literal-num", { exactTitleTokenMatch: true, versionMatch: false }),
      hit("dotted", { dottedSpanComponentTitleMatch: true, directClass: "weak" }),
      hit("lead", { shortLiteralLeadMatch: true }),
    ]);
  });

  test("incomparable buckets interleave by score then id, not concatenation", () => {
    const ranked = rankBoth([
      hit("exact-low", { exactTitleMatch: true, retrievalScore: 0.1 }),
      hit("other-high", { exactTitleMatch: false, queryCoverage: 0, retrievalScore: 9 }),
      hit("exact-high", { exactTitleMatch: true, retrievalScore: 5 }),
      hit("other-mid", { exactTitleMatch: false, queryCoverage: 0, retrievalScore: 4 }),
    ]);
    expect(ranked.map((row) => row.document.id)).toEqual(["exact-high", "exact-low", "other-high", "other-mid"]);
  });

  test("custom id-based cycle constraints stay pairwise and match the oracle", () => {
    const defs = [
      { id: "cycle", invariant: "test", class: "strong", fn: cycleAmong(["b", "c", "a"]) },
      { id: "cycle2", invariant: "test", class: "strong", fn: cycleAmong(["e", "f", "d"]) },
    ];
    const cands = ["a", "b", "c", "d", "e", "f"].map((id) => hit(id));
    rankBoth(cands, defs);
  });

  test("deterministic pseudo-random mixtures match the oracle", () => {
    const rng = mulberry32(0x4d4f444c);
    for (const size of [8, 16, 24, 40]) {
      const cands = [];
      for (let i = 0; i < size; i++) {
        cands.push(hit(`d${String(i).padStart(3, "0")}`, randomFeatures(rng)));
      }
      rankBoth(cands, DEFAULT_CONSTRAINTS);
      rankBoth(cands, HYBRID_CONSTRAINTS);
    }
  });

  test("repeated runs are identical", () => {
    const cands = [
      hit("x", { exactTitleMatch: true, queryCoverage: 1, titleCoverage: 0.9, titleTokenCount: 3 }),
      hit("y", { queryCoverage: 0.4, directClass: "weak" }),
      hit("z", { relevanceKind: "related" }),
      hit("w", { contextualTitlePrefix: true, contextualPrefixQuality: 0.7, directClass: "weak" }),
    ];
    const a = rankCandidates(cands);
    const b = rankCandidates(cands);
    expectEquivalent(a, b);
    expectEquivalent(a, rankCandidatesPairwise(cands));
  });

  test("async ranking matches the sync oracle", async () => {
    const cands = [
      hit("a", { exactTitleMatch: true }),
      hit("b", { queryCoverage: 0.3, directClass: "weak" }),
      hit("c", { relevanceKind: "related" }),
    ];
    const expected = rankCandidatesPairwise(cands);
    expectEquivalent(await rankCandidatesAsync(cands), expected);
    expectEquivalent(await rankCandidatesPairwiseAsync(cands), expected);
  });

  test("homogeneous builtin ranking uses one signature and no candidate pairs", () => {
    const cands = [];
    for (let i = 0; i < 40; i++) {
      cands.push(hit(`h${String(i).padStart(3, "0")}`, { queryCoverage: 0.2, retrievalScore: i / 40 }));
    }
    rankBoth(cands);
    expect(lastRankStats()).toEqual(
      expect.objectContaining({
        mode: "sparse",
        C: 40,
        B: 1,
        kAmbiguous: 0,
        bucketCompares: 0,
        candidatePairCompares: 0,
        bucketEdges: 0,
      })
    );
  });

  test("few dominance signatures do not materialize bipartite candidate edges", () => {
    const cands = [];
    for (let i = 0; i < 30; i++) {
      cands.push(hit(`e${String(i).padStart(3, "0")}`, { exactTitleMatch: true, retrievalScore: i }));
    }
    for (let i = 0; i < 30; i++) {
      cands.push(hit(`n${String(i).padStart(3, "0")}`, { exactTitleMatch: false, queryCoverage: 0, retrievalScore: i }));
    }
    rankBoth(cands);
    const stats = lastRankStats();
    expect(stats?.mode).toBe("sparse");
    expect(stats?.C).toBe(60);
    expect(stats?.B).toBe(2);
    expect(stats?.bucketCompares).toBe(1);
    expect(stats?.candidatePairCompares).toBe(0);
    expect(stats?.bucketEdges).toBe(1);
  });

  test("signature equality implies compareConstraint order 0", () => {
    const rng = mulberry32(0x5349474e);
    const bySig = new Map();
    for (let i = 0; i < 200; i++) {
      const features = randomFeatures(rng);
      const key = constraintSignature(features);
      const row = hit(`r${i}`, features);
      if (!bySig.has(key)) bySig.set(key, []);
      bySig.get(key).push(row);
    }
    for (const group of bySig.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const cmp = compareConstraint(group[i], group[j], DEFAULT_CONSTRAINTS);
          expect(cmp.order).toBe(0);
          expect(cmp.conflict).toBe(false);
          const hy = compareConstraint(group[i], group[j], HYBRID_CONSTRAINTS);
          expect(hy.order).toBe(0);
          expect(hy.conflict).toBe(false);
        }
      }
    }
  });
});

describe("ranking equivalence on Software.Land featured hits", () => {
  let engine;
  const documents = loadJson("documents.json");
  const configuredConcepts = loadJson("configured-concepts.json");
  const lemmas = loadJson("lemmas.json");
  const relationships = loadJson("relationships.json");
  const lexicalFrequency = loadJson("lexical-frequency.json");
  const contracts = loadJson("v2-contracts.json");
  const regressions = loadJson("regression-scenarios.json");

  beforeAll(async () => {
    engine = SearchEngine.create({
      schema: {
        title: { type: "text", role: "title" },
        body: { type: "text", role: "body" },
      },
      plugins: [morphology({ lemmas }), compileConfiguredConceptPlugin({ configuredConcepts: configuredConcepts })],
      documentRelationships: relationships,
      relationshipStrategy: "hybrid",
      retriever: "full-scan",
    });
    await engine.index(attachLexicalFrequency(documents, lexicalFrequency));
  });

  function featuredFromDetailed(detailed) {
    return detailed.results.map((row) => ({
      document: { id: row.id, title: row.title },
      features: row.features,
      retrievalSources: row.retrievalSources,
    }));
  }

  test("query 2 featured set ranks identically under the oracle", () => {
    const detailed = engine.searchDetailed("2", { limit: 1000, explain: true });
    expect(detailed.results.slice(0, 2).map((row) => row.title)).toEqual([
      "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
      "TLS 1.2 Vulnerability",
    ]);
    const cands = featuredFromDetailed(detailed);
    const ranked = rankBoth(cands, HYBRID_CONSTRAINTS);
    expect(ranked.map((row) => row.document.id)).toEqual(detailed.results.map((row) => row.id));
  });

  test.each(contracts.cases.map((row) => [row.name, row.query]))("contract featured ranking %s", (_name, query) => {
    const detailed = engine.searchDetailed(query, { limit: 1000, explain: true });
    rankBoth(featuredFromDetailed(detailed), HYBRID_CONSTRAINTS);
  });

  test.each(regressions.cases.map((row) => [row.name, row.query]))("regression featured ranking %s", (_name, query) => {
    const detailed = engine.searchDetailed(query, { limit: 1000, explain: true });
    rankBoth(featuredFromDetailed(detailed), HYBRID_CONSTRAINTS);
  });
});
