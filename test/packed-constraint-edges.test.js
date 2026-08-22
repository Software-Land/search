import { isAbortError } from "../dist/index.js";
import {
  PackedConstraintEdges,
  PACKED_CONSTRAINT_EDGE_CHUNK_EDGES,
  buildConstraintGraph,
  buildConstraintGraphAsync,
  detectConstraintCycles,
  diagnoseConstraintGraph,
  stronglyConnectedComponents,
} from "../dist/constraints.js";
import { rankCandidates, rankCandidatesAsync } from "../dist/rank.js";

function blankFeatures(over = {}) {
  return {
    exactTitleMatch: false,
    exactTitleTokenMatch: false,
    titleCoverage: 0,
    queryCoverage: 0,
    titlePrefixQuality: 0,
    configuredEquivalenceMatch: false,
    morphologyMatch: false,
    typoDistance: 0,
    versionMatch: false,
    shortLiteralLeadMatch: false,
    phraseAdjacency: 0,
    bodyLexicalMatch: 0,
    titleTokenCount: 3,
    expansionEvidence: 0,
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

function abortAfter(n) {
  let calls = 0;
  return {
    get aborted() {
      return ++calls > n;
    },
  };
}

describe("PackedConstraintEdges", () => {
  test("zero edges allocate nothing and iterate empty", () => {
    const edges = new PackedConstraintEdges(4);
    expect(edges.length).toBe(0);
    expect(edges.allocatedBytes()).toBe(0);
    expect([...edges]).toEqual([]);
    const seen = [];
    edges.forEachEdge((u, v) => seen.push([u, v]));
    expect(seen).toEqual([]);
  });

  test("one edge", () => {
    const edges = new PackedConstraintEdges(4);
    edges.append(3, 1);
    expect(edges.length).toBe(1);
    expect(edges.fromAt(0)).toBe(3);
    expect(edges.toAt(0)).toBe(1);
    expect([...edges]).toEqual([[3, 1]]);
    expect(edges.allocatedBytes()).toBe(4 * 8);
  });

  test("insertion order is preserved across chunk boundaries", () => {
    const edges = new PackedConstraintEdges(2);
    const expected = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 0],
    ];
    for (const [u, v] of expected) edges.append(u, v);
    expect(edges.length).toBe(5);
    expect(edges.chunkEdges).toBe(2);
    expect(edges.allocatedBytes()).toBe(3 * 2 * 8);
    expect([...edges]).toEqual(expected);
    const seen = [];
    edges.forEachEdge((u, v) => seen.push([u, v]));
    expect(seen).toEqual(expected);
    for (let i = 0; i < expected.length; i++) {
      expect([edges.fromAt(i), edges.toAt(i)]).toEqual(expected[i]);
    }
  });

  test("default chunk size is 65536 edges", () => {
    expect(PACKED_CONSTRAINT_EDGE_CHUNK_EDGES).toBe(65536);
    const edges = new PackedConstraintEdges();
    expect(edges.chunkEdges).toBe(65536);
    edges.append(0, 1);
    expect(edges.allocatedBytes()).toBe(65536 * 8);
  });

  test("out-of-range index throws", () => {
    const edges = new PackedConstraintEdges(2);
    expect(() => edges.fromAt(0)).toThrow(RangeError);
    edges.append(1, 2);
    expect(() => edges.toAt(1)).toThrow(RangeError);
    expect(() => edges.fromAt(-1)).toThrow(RangeError);
  });
});

describe("packed constraint graph consumers", () => {
  test("buildConstraintGraph edge count and order match pairwise append order", () => {
    const candidates = [hit("a"), hit("b"), hit("c"), hit("d")];
    const defs = [
      {
        id: "lower-index-wins",
        invariant: "test",
        class: "absolute",
        fn: (a, b) => {
          if (a.document.id < b.document.id) return -1;
          if (a.document.id > b.document.id) return 1;
          return 0;
        },
      },
    ];
    const graph = buildConstraintGraph(candidates, defs);
    expect(graph.edges.length).toBe(6);
    expect([...graph.edges]).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
  });

  test("SCC over packed edges matches cycle diagnosis", () => {
    const defs = [
      {
        id: "cycle",
        invariant: "test",
        class: "strong",
        fn: (a, b) => {
          const order = { a: 0, b: 1, c: 2 };
          if (!(a.document.id in order) || !(b.document.id in order)) return 0;
          const d = (order[b.document.id] - order[a.document.id] + 3) % 3;
          if (d === 1) return -1;
          if (d === 2) return 1;
          return 0;
        },
      },
    ];
    const candidates = [hit("b"), hit("c"), hit("a")];
    const graph = buildConstraintGraph(candidates, defs);
    const scc = stronglyConnectedComponents(graph.n, graph.edges);
    expect(scc.cycles).toHaveLength(1);
    expect(scc.cycles[0].slice().sort((x, y) => x - y)).toEqual([0, 1, 2]);
    const diagnosis = diagnoseConstraintGraph(graph, candidates);
    expect([...diagnosis.cycles[0]].sort()).toEqual(["a", "b", "c"]);
    expect(diagnosis).toEqual(detectConstraintCycles(candidates, defs));
  });

  test("conflicts remain reports without packed edges", () => {
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
    expect(graph.edges.length).toBe(0);
    expect(graph.pairReports).toHaveLength(1);
    expect(graph.pairReports[0].resolution).toBe("unordered-same-class-conflict");
  });

  test("sync and async packed graphs are equal", async () => {
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
    const sync = buildConstraintGraph(candidates, defs);
    const asyncd = await buildConstraintGraphAsync(candidates, defs);
    expect(asyncd.n).toBe(sync.n);
    expect(asyncd.edges.length).toBe(sync.edges.length);
    expect([...asyncd.edges]).toEqual([...sync.edges]);
    expect(asyncd.pairReports).toEqual(sync.pairReports);
    const ranked = rankCandidates(candidates, { constraints: defs });
    const rankedAsync = await rankCandidatesAsync(candidates, { constraints: defs });
    expect(rankedAsync.map((r) => r.document.id)).toEqual(ranked.map((r) => r.document.id));
    expect(ranked.map((r) => r.document.id)).toEqual(["other", "winner", "loser"]);
  });

  test("buildConstraintGraph honors cancellation", () => {
    const candidates = [hit("a"), hit("b"), hit("c")];
    try {
      buildConstraintGraph(candidates, [], { signal: abortAfter(0) });
      throw new Error("expected AbortError");
    } catch (err) {
      expect(isAbortError(err)).toBe(true);
    }
    const graph = buildConstraintGraph(candidates, [], { signal: abortAfter(100) });
    expect(graph.edges.length).toBe(0);
  });
});
