import { morphology, SearchEngine } from "../dist/index.js";
import { compileConfiguredConceptPlugin } from "../dist/configuredConcepts.js";
import {
  buildConstraintGraph,
  buildConstraintGraphAsync,
  compareConstraint,
  constraintsForStrategy,
  DEFAULT_CONSTRAINTS,
  detectConstraintCycles,
  diagnoseConstraintGraph,
  HYBRID_CONSTRAINTS,
} from "../dist/ranking/constraints.js";
import { rankCandidates, rankCandidatesAsync } from "../dist/ranking/rank.js";

function edgePairs(edges) {
  return [...edges];
}

function blankFeatures(over = {}) {
  return {
    exactTitleMatch: false,
    exactTitleTokenMatch: false,
    titleCoverage: 0,
    queryCoverage: 0,
    titlePrefixQuality: 0,
    configuredConceptMatch: false,
    morphologyMatch: false,
    typoDistance: 0,
    versionMatch: false,
    shortLiteralLeadMatch: false,
    phraseAdjacency: 0,
    bodyLexicalMatch: 0,
    titleTokenCount: 3,
    configuredFormEvidence: 0,
    canonicalKeyTitle: false,
    relationshipStrength: 0,
    relationshipType: null,
    relationshipSourceId: null,
    relevanceKind: "direct",
    directClass: "none",
    ...over,
  };
}

function hit(id, over = {}) {
  return { document: { id, title: id }, features: blankFeatures(over) };
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

function countingDefs(inner = []) {
  let pairEvals = 0;
  const defs = [
    {
      id: "count-pairs",
      invariant: "test",
      class: "soft",
      fn: (a, b) => {
        pairEvals += 1;
        return 0;
      },
    },
    ...inner,
  ];
  return {
    defs,
    pairEvals: () => pairEvals,
  };
}

describe("diagnoseConstraintGraph reuses a built graph", () => {
  test("no constraint edges", () => {
    const candidates = [hit("b"), hit("a"), hit("c")];
    const defs = [];
    const graph = buildConstraintGraph(candidates, defs);
    expect(edgePairs(graph.edges)).toEqual([]);
    expect(graph.edges.length).toBe(0);
    expect(graph.pairReports).toEqual([]);
    expect(diagnoseConstraintGraph(graph, candidates)).toEqual(detectConstraintCycles(candidates, defs));
  });

  test("one decisive edge", () => {
    const candidates = [hit("loser"), hit("winner"), hit("other")];
    const defs = [
      {
        id: "winner-over-loser",
        invariant: "test",
        class: "absolute",
        fn: (a, b) => {
          if (a.document.id === "winner" && b.document.id === "loser") return -1;
          if (a.document.id === "loser" && b.document.id === "winner") return 1;
          return 0;
        },
      },
    ];
    const graph = buildConstraintGraph(candidates, defs);
    expect(edgePairs(graph.edges)).toEqual([[1, 0]]);
    expect(graph.pairReports).toEqual([]);
    expect(diagnoseConstraintGraph(graph, candidates)).toEqual(detectConstraintCycles(candidates, defs));
  });

  test("same-class conflict", () => {
    const candidates = [hit("a"), hit("b")];
    const defs = [
      {
        id: "rule-ab",
        invariant: "test",
        class: "strong",
        fn: (a, b) => (a.document.id === "a" && b.document.id === "b" ? -1 : a.document.id === "b" && b.document.id === "a" ? 1 : 0),
      },
      {
        id: "rule-ba",
        invariant: "test",
        class: "strong",
        fn: (a, b) => (a.document.id === "a" && b.document.id === "b" ? 1 : a.document.id === "b" && b.document.id === "a" ? -1 : 0),
      },
    ];
    const graph = buildConstraintGraph(candidates, defs);
    expect(edgePairs(graph.edges)).toEqual([]);
    expect(graph.edges.length).toBe(0);
    expect(graph.pairReports[0].conflict).toBe(true);
    expect(graph.pairReports[0].resolution).toBe("unordered-same-class-conflict");
    expect(diagnoseConstraintGraph(graph, candidates)).toEqual(detectConstraintCycles(candidates, defs));
  });

  test("actual cycle", () => {
    const defs = [{ id: "cycle", invariant: "test", class: "strong", fn: cycleAmong(["a", "b", "c"]) }];
    const candidates = [hit("b", { queryCoverage: 0.2 }), hit("c", { queryCoverage: 0.9 }), hit("a", { queryCoverage: 0.5 })];
    const graph = buildConstraintGraph(candidates, defs);
    const fromGraph = diagnoseConstraintGraph(graph, candidates);
    expect(fromGraph).toEqual(detectConstraintCycles(candidates, defs));
    expect(fromGraph.cycles[0].sort()).toEqual(["a", "b", "c"]);
  });

  test("multiple SCCs", () => {
    const defs = [
      {
        id: "two-cycles",
        invariant: "test",
        class: "strong",
        fn: (a, b) => cycleAmong(["a", "b", "c"])(a, b) || cycleAmong(["d", "e", "f"])(a, b),
      },
    ];
    const candidates = ["b", "c", "a", "e", "f", "d"].map((id) => hit(id, { queryCoverage: id === "c" || id === "f" ? 0.9 : 0.2 }));
    const graph = buildConstraintGraph(candidates, defs);
    const fromGraph = diagnoseConstraintGraph(graph, candidates);
    expect(fromGraph).toEqual(detectConstraintCycles(candidates, defs));
    expect(fromGraph.cycles).toHaveLength(2);
    expect(fromGraph.cycles.map((c) => [...c].sort())).toEqual(
      expect.arrayContaining([
        ["a", "b", "c"],
        ["d", "e", "f"],
      ])
    );
  });
});

describe("ranking reuses graph construction", () => {
  test("one ranking invocation evaluates unordered pairs once plus constraintVsNext", () => {
    for (const C of [10, 50, 100, 200]) {
      const { defs, pairEvals } = countingDefs();
      const candidates = Array.from({ length: C }, (_, i) => hit(`id-${String(i).padStart(3, "0")}`));
      rankCandidates(candidates, { constraints: defs });
      const unorderedPairs = (C * (C - 1)) / 2;
      expect(pairEvals()).toBe(unorderedPairs + Math.max(0, C - 1));
    }
  });

  test("200 candidates: unordered pairs are not retained; ranking is deterministic", () => {
    const C = 200;
    const candidates = Array.from({ length: C }, (_, i) => hit(`id-${String(i).padStart(3, "0")}`));
    const graph = buildConstraintGraph(candidates, []);
    expect(edgePairs(graph.edges)).toEqual([]);
    expect(graph.edges.length).toBe(0);
    expect(graph.pairReports).toHaveLength(0);
    const first = rankCandidates(candidates, { constraints: [] }).map((r) => r.document.id);
    const second = rankCandidates(candidates, { constraints: [] }).map((r) => r.document.id);
    expect(first).toEqual(second);
    expect(first).toHaveLength(200);
  });

  test("ID tie-break, constraintVsNext, and DEFAULT/HYBRID stay distinct where they should", () => {
    const tied = rankCandidates([hit("b"), hit("a")]);
    expect(tied.map((r) => r.document.id)).toEqual(["a", "b"]);
    expect(tied[0].rank).toBe(1);
    expect(tied[0].constraintVsNext).toEqual(compareConstraint(tied[0], tied[1], DEFAULT_CONSTRAINTS));

    const exact = hit("exact", {
      exactTitleMatch: true,
      exactTitleTokenMatch: true,
      queryCoverage: 1,
      titleCoverage: 1,
      directClass: "strong",
    });
    const weak = hit("weak", { queryCoverage: 0, bodyLexicalMatch: 1, directClass: "weak" });
    const ranked = rankCandidates([weak, exact]);
    expect(ranked.map((r) => r.document.id)).toEqual(["exact", "weak"]);
    expect(ranked[0].constraintVsNext.order).toBe(-1);
    expect(ranked[0].constraintVsNext).toEqual(compareConstraint(ranked[0], ranked[1], DEFAULT_CONSTRAINTS));

    const related = hit("related", { relevanceKind: "related", relationshipStrength: 0.8, directClass: "none" });
    const weakDirect = hit("weak-direct", { relevanceKind: "direct", directClass: "weak", queryCoverage: 0 });
    const defaultRanked = rankCandidates([related, weakDirect], { constraints: constraintsForStrategy("mixed") });
    const hybridRanked = rankCandidates([related, weakDirect], { constraints: constraintsForStrategy("hybrid") });
    expect(constraintsForStrategy("mixed")).toBe(DEFAULT_CONSTRAINTS);
    expect(constraintsForStrategy("hybrid")).toBe(HYBRID_CONSTRAINTS);
    expect(hybridRanked.map((r) => r.document.id)).toEqual(["related", "weak-direct"]);
    expect(hybridRanked[0].constraintVsNext.order).toBe(-1);
    expect(defaultRanked[0].constraintMeta.conflictCount).toBe(hybridRanked[0].constraintMeta.conflictCount);
  });

  test("sync and async ranking are equal", async () => {
    const candidates = [
      hit("exact", { exactTitleMatch: true, queryCoverage: 1, directClass: "strong" }),
      hit("weak", { directClass: "weak", bodyLexicalMatch: 1 }),
      hit("related", { relevanceKind: "related", relationshipStrength: 0.5 }),
    ];
    const sync = rankCandidates(candidates);
    const asyncd = await rankCandidatesAsync(candidates);
    expect(asyncd.map((r) => ({ id: r.document.id, rank: r.rank, score: r.score }))).toEqual(
      sync.map((r) => ({ id: r.document.id, rank: r.rank, score: r.score }))
    );
    expect(asyncd.map((r) => r.constraintVsNext)).toEqual(sync.map((r) => r.constraintVsNext));
    expect(asyncd.map((r) => r.constraintMeta)).toEqual(sync.map((r) => r.constraintMeta));
  });
});

describe("constraint graph retains only edges and conflicts", () => {
  test("unordered no-decision pairs are compared but not retained", async () => {
    const candidates = [hit("c"), hit("a"), hit("b")];
    const sync = buildConstraintGraph(candidates, []);
    const asyncd = await buildConstraintGraphAsync(candidates, []);
    expect(sync.n).toBe(3);
    expect(edgePairs(sync.edges)).toEqual([]);
    expect(sync.pairReports).toEqual([]);
    expect(asyncd.n).toBe(sync.n);
    expect(edgePairs(asyncd.edges)).toEqual(edgePairs(sync.edges));
    expect(asyncd.pairReports).toEqual(sync.pairReports);
  });

  test("decisive ordered pairs become edges without a retained report", () => {
    const candidates = [hit("loser"), hit("winner")];
    const defs = [
      {
        id: "winner-over-loser",
        invariant: "test",
        class: "absolute",
        fn: (a, b) => {
          if (a.document.id === "winner" && b.document.id === "loser") return -1;
          if (a.document.id === "loser" && b.document.id === "winner") return 1;
          return 0;
        },
      },
    ];
    const graph = buildConstraintGraph(candidates, defs);
    expect(edgePairs(graph.edges)).toEqual([[1, 0]]);
    expect(graph.pairReports).toEqual([]);
  });

  test("same-class conflicts are retained and still unordered", () => {
    const candidates = [hit("a"), hit("b")];
    const defs = [
      {
        id: "rule-ab",
        invariant: "test",
        class: "strong",
        fn: (a, b) => (a.document.id === "a" && b.document.id === "b" ? -1 : 0),
      },
      {
        id: "rule-ba",
        invariant: "test",
        class: "strong",
        fn: (a, b) => (a.document.id === "a" && b.document.id === "b" ? 1 : 0),
      },
    ];
    const graph = buildConstraintGraph(candidates, defs);
    expect(edgePairs(graph.edges)).toEqual([]);
    expect(graph.edges.length).toBe(0);
    expect(graph.pairReports).toHaveLength(1);
    expect(graph.pairReports[0]).toMatchObject({
      i: 0,
      j: 1,
      order: 0,
      conflict: true,
      resolution: "unordered-same-class-conflict",
    });
    const diagnosis = diagnoseConstraintGraph(graph, candidates);
    expect(diagnosis.conflicts).toEqual([
      {
        a: "a",
        b: "b",
        applied: graph.pairReports[0].applied,
        resolution: "unordered-same-class-conflict",
      },
    ]);
    expect(diagnosis.pairReports).toEqual(graph.pairReports);
  });

  test("stronger-class-wins pairs keep an edge and a conflict report", () => {
    const candidates = [hit("a"), hit("b")];
    const defs = [
      {
        id: "absolute-ab",
        invariant: "test",
        class: "absolute",
        fn: (a, b) => (a.document.id === "a" && b.document.id === "b" ? -1 : 0),
      },
      {
        id: "soft-ba",
        invariant: "test",
        class: "soft",
        fn: (a, b) => (a.document.id === "a" && b.document.id === "b" ? 1 : 0),
      },
    ];
    const graph = buildConstraintGraph(candidates, defs);
    expect(edgePairs(graph.edges)).toEqual([[0, 1]]);
    expect(graph.pairReports).toHaveLength(1);
    expect(graph.pairReports[0]).toMatchObject({
      conflict: true,
      resolution: "stronger-class-wins",
      order: -1,
    });
  });

  test("public search meta exposes cycles and conflictCount, not pairReports", async () => {
    const e = SearchEngine.create({
      schema: { title: { type: "text", role: "title" }, body: { type: "text", role: "body" } },
      plugins: [morphology()],
    });
    await e.index([
      { id: "exact", title: "Bluetooth", body: "wireless" },
      { id: "other", title: "Other", body: "notes" },
    ]);
    const detailed = e.searchDetailed("bluetooth", { limit: 10, explain: true });
    expect(detailed.meta).not.toHaveProperty("pairReports");
    expect(Array.isArray(detailed.meta.constraintCycles)).toBe(true);
    expect(typeof detailed.meta.constraintConflicts).toBe("number");
    expect(detailed.results[0].explanation.constraintMeta).toEqual({
      cycles: detailed.meta.constraintCycles,
      conflictCount: detailed.meta.constraintConflicts,
    });
    expect(e.lastSearchMeta).not.toHaveProperty("pairReports");
  });
});

describe("query 2 ranking is unchanged", () => {
  const docs = [
    {
      id: "/200fps/",
      title: "200FPS: CSS vs Canvas vs WebGL vs WebGPU",
      body: "Compare CSS, Canvas, WebGL, and WebGPU at 200 frames per second.",
    },
    {
      id: "/tls/",
      title: "TLS 1.2 Vulnerability",
      body: "TLS 1.2 protocol vulnerability and AES-128 cipher suites.",
    },
    { id: "/http2/", title: "HTTP/2", body: "HTTP/2 multiplexed streams." },
    { id: "/d3d/", title: "Direct3D 12 Guide", body: "A guide to Direct3D 12." },
    { id: "/protobuf/", title: "Protobuf Encoding", body: "Field number 2 in the payload." },
    { id: "/rr/", title: "Request Response", body: "HTTP/1.1 vs HTTP/2 in the body only." },
    { id: "/rest/", title: "REST API vs GraphQL", body: "Version 2 of the API comparison." },
  ];
  const tlsDict = [
    { key: "tls", aliases: [["transport", "layer", "security"]]},
    { key: "oop", aliases: [["object", "oriented", "programming"]]},
    { key: "api", aliases: [["application", "programming", "interface"]]},
  ];

  test("query 2 ranks HTTP/2 then 200FPS then TLS, with explanations", async () => {
    const e = SearchEngine.create({
      schema: {
        title: { type: "text", role: "title" },
        body: { type: "text", role: "body" },
      },
      plugins: [morphology(), compileConfiguredConceptPlugin({ configuredConcepts: tlsDict })],
    });
    await e.index(docs);
    const detailed = e.searchDetailed("2", { limit: 10, explain: true });
    const asyncd = await e.searchDetailedAsync("2", { limit: 10, explain: true });
    expect(detailed.results.map((r) => r.id)).toEqual(["/http2/", "/200fps/", "/tls/", "/protobuf/", "/rest/", "/rr/"]);
    expect(asyncd.results.map((r) => r.id)).toEqual(detailed.results.map((r) => r.id));
    expect(detailed.results[0].title).toBe("HTTP/2");
    expect(detailed.results[1].title).toBe("200FPS: CSS vs Canvas vs WebGL vs WebGPU");
    expect(detailed.results[2].title).toBe("TLS 1.2 Vulnerability");
    expect(detailed.results[0].features.exactTitleTokenMatch).toBe(true);
    expect(detailed.results[1].features.shortLiteralLeadMatch).toBe(true);
    expect(detailed.results[2].features.dottedSpanComponentTitleMatch).toBe(true);
    expect(detailed.results[0].explanation.constraintsVsNext).toBeTruthy();
    expect(detailed.results[0].explanation.constraintMeta).toEqual({
      cycles: detailed.meta.constraintCycles,
      conflictCount: detailed.meta.constraintConflicts,
    });
    expect(Array.isArray(detailed.meta.constraintCycles)).toBe(true);
    expect(typeof detailed.meta.constraintConflicts).toBe("number");
  });
});
