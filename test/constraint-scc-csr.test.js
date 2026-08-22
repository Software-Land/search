import { isAbortError } from "../dist/index.js";
import {
  PackedConstraintEdges,
  advanceConstraintStamp,
  buildConstraintCsr,
  buildConstraintGraph,
  computeComponentIndegrees,
  constraintCsrBytes,
  CONSTRAINT_STAMP_MAX,
  csrNeighborList,
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

function jsAdj(n, edges, reverse = false) {
  const adj = Array.from({ length: n }, () => []);
  edges.forEachEdge((u, v) => {
    if (reverse) adj[v].push(u);
    else adj[u].push(v);
  });
  return adj;
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

describe("constraint CSR neighbor order", () => {
  test("empty graph has zero-length neighbor arrays", () => {
    const edges = new PackedConstraintEdges(4);
    const adj = buildConstraintCsr(3, edges, false);
    const radj = buildConstraintCsr(3, edges, true);
    expect(Array.from(adj.offsets)).toEqual([0, 0, 0, 0]);
    expect(adj.neighbors.length).toBe(0);
    expect(radj.neighbors.length).toBe(0);
    expect(csrNeighborList(adj, 1)).toEqual([]);
    const scc = stronglyConnectedComponents(3, edges);
    expect(scc.groups).toEqual([[2], [1], [0]]);
    expect(scc.cycles).toEqual([]);
    expect(scc.radj).toBeUndefined();
    expect(scc.adj.neighbors.length).toBe(0);
  });

  test("interleaved edges preserve forward and reverse push order", () => {
    const n = 4;
    const edges = new PackedConstraintEdges(8);
    const pairs = [
      [0, 1],
      [2, 0],
      [0, 3],
      [1, 2],
      [0, 2],
      [3, 1],
      [2, 3],
    ];
    for (const [u, v] of pairs) edges.append(u, v);
    const forward = buildConstraintCsr(n, edges, false);
    const reverse = buildConstraintCsr(n, edges, true);
    const jsF = jsAdj(n, edges, false);
    const jsR = jsAdj(n, edges, true);
    for (let u = 0; u < n; u++) {
      expect(csrNeighborList(forward, u)).toEqual(jsF[u]);
      expect(csrNeighborList(reverse, u)).toEqual(jsR[u]);
    }
    const scc = stronglyConnectedComponents(n, edges);
    for (let u = 0; u < n; u++) expect(csrNeighborList(scc.adj, u)).toEqual(jsF[u]);
    expect(scc).not.toHaveProperty("radj");
    expect(constraintCsrBytes(forward)).toBe((n + 1) * 4 + pairs.length * 4);
  });
});

describe("Kosaraju CSR grouping", () => {
  test("simple DAG is one vertex per component in finish-derived ids", () => {
    const edges = new PackedConstraintEdges(8);
    edges.append(0, 1);
    edges.append(0, 2);
    edges.append(1, 3);
    edges.append(2, 3);
    const scc = stronglyConnectedComponents(4, edges);
    expect(scc.cycles).toEqual([]);
    expect(scc.groups).toEqual([[0], [2], [1], [3]]);
  });

  test("one cycle keeps exact member order (increasing vertex index)", () => {
    const edges = new PackedConstraintEdges(8);
    edges.append(0, 1);
    edges.append(1, 2);
    edges.append(2, 0);
    const scc = stronglyConnectedComponents(3, edges);
    expect(scc.cycles).toEqual([[0, 1, 2]]);
    expect(scc.cycles[0]).not.toBe(scc.groups[scc.comp[0]]);
    scc.groups[scc.comp[0]].push(99);
    expect(scc.cycles[0]).toEqual([0, 1, 2]);
  });

  test("multiple disjoint cycles keep cid order and member order", () => {
    const edges = new PackedConstraintEdges(8);
    edges.append(0, 1);
    edges.append(1, 2);
    edges.append(2, 0);
    edges.append(3, 4);
    edges.append(4, 5);
    edges.append(5, 3);
    const scc = stronglyConnectedComponents(6, edges);
    expect(scc.cycles).toEqual([
      [3, 4, 5],
      [0, 1, 2],
    ]);
  });

  test("connected SCCs merge into one cycle group", () => {
    const edges = new PackedConstraintEdges(8);
    edges.append(0, 1);
    edges.append(1, 2);
    edges.append(2, 0);
    edges.append(1, 3);
    edges.append(3, 0);
    const scc = stronglyConnectedComponents(4, edges);
    expect(scc.cycles).toEqual([[0, 1, 2, 3]]);
  });

  test("disconnected isolates plus a cycle", () => {
    const edges = new PackedConstraintEdges(8);
    edges.append(2, 3);
    edges.append(3, 4);
    edges.append(4, 2);
    const scc = stronglyConnectedComponents(6, edges);
    expect(scc.cycles).toEqual([[2, 3, 4]]);
    expect(scc.groups.filter((g) => g.length === 1).map((g) => g[0]).sort((a, b) => a - b)).toEqual([0, 1, 5]);
  });
});

describe("component indegree generation-stamp dedup", () => {
  test("many vertex edges from SCC A to SCC B increment indegree once", () => {
    const edges = new PackedConstraintEdges(32);
    edges.append(0, 1);
    edges.append(1, 2);
    edges.append(2, 0);
    edges.append(3, 4);
    edges.append(4, 5);
    edges.append(5, 3);
    for (const a of [0, 1, 2]) for (const b of [3, 4, 5]) edges.append(a, b);
    const scc = stronglyConnectedComponents(6, edges);
    expect(scc.cycles).toHaveLength(2);
    const indeg = computeComponentIndegrees(scc.comp, scc.groups, scc.adj);
    const a = scc.comp[0];
    const b = scc.comp[3];
    expect(a).not.toBe(b);
    expect(indeg[a]).toBe(0);
    expect(indeg[b]).toBe(1);
    const sum = Array.from(indeg).reduce((x, y) => x + y, 0);
    expect(sum).toBe(1);
  });

  test("duplicate edges to several successor SCCs increment each indegree once", () => {
    const edges = new PackedConstraintEdges(16);
    edges.append(0, 1);
    edges.append(1, 0);
    edges.append(0, 2);
    edges.append(1, 2);
    edges.append(0, 2);
    edges.append(0, 3);
    edges.append(1, 3);
    edges.append(2, 4);
    const scc = stronglyConnectedComponents(5, edges);
    expect(scc.cycles).toEqual([[0, 1]]);
    const indeg = computeComponentIndegrees(scc.comp, scc.groups, scc.adj);
    expect(indeg[scc.comp[0]]).toBe(0);
    expect(indeg[scc.comp[2]]).toBe(1);
    expect(indeg[scc.comp[3]]).toBe(1);
    expect(indeg[scc.comp[4]]).toBe(1);
    expect(Array.from(indeg).reduce((a, b) => a + b, 0)).toBe(3);
  });

  test("cycle with outgoing DAG edges dedups only cross-component successors", () => {
    const edges = new PackedConstraintEdges(16);
    edges.append(0, 1);
    edges.append(1, 2);
    edges.append(2, 0);
    edges.append(0, 3);
    edges.append(1, 3);
    edges.append(2, 3);
    edges.append(1, 4);
    const scc = stronglyConnectedComponents(6, edges);
    expect(scc.cycles).toEqual([[0, 1, 2]]);
    const indeg = computeComponentIndegrees(scc.comp, scc.groups, scc.adj);
    expect(indeg[scc.comp[0]]).toBe(0);
    expect(indeg[scc.comp[3]]).toBe(1);
    expect(indeg[scc.comp[4]]).toBe(1);
    expect(indeg[scc.comp[5]]).toBe(0);
  });

  test("stamp wrap resets marks instead of colliding", () => {
    const marks = new Uint32Array([CONSTRAINT_STAMP_MAX, 7, 0]);
    const next = advanceConstraintStamp(marks, CONSTRAINT_STAMP_MAX);
    expect(next).toBe(1);
    expect(Array.from(marks)).toEqual([0, 0, 0]);
    expect(advanceConstraintStamp(marks, 0)).toBe(1);
    expect(advanceConstraintStamp(marks, 1)).toBe(2);
  });
});

describe("ranking and diagnosis over CSR SCC", () => {
  test("duplicate cross-component edges keep ranking and indegree semantics", () => {
    const defs = [
      {
        id: "two-cycles-and-cross",
        invariant: "test",
        class: "strong",
        fn: (a, b) => {
          const cycle = cycleAmong(["a", "b", "c"])(a, b) || cycleAmong(["d", "e", "f"])(a, b);
          if (cycle) return cycle;
          const left = new Set(["a", "b", "c"]);
          const right = new Set(["d", "e", "f"]);
          if (left.has(a.document.id) && right.has(b.document.id)) return -1;
          if (right.has(a.document.id) && left.has(b.document.id)) return 1;
          return 0;
        },
      },
    ];
    const candidates = ["b", "c", "a", "e", "f", "d"].map((id) =>
      hit(id, { queryCoverage: id === "c" || id === "f" ? 0.9 : 0.2 })
    );
    const graph = buildConstraintGraph(candidates, defs);
    const scc = stronglyConnectedComponents(graph.n, graph.edges);
    expect(scc.cycles).toHaveLength(2);
    const indeg = computeComponentIndegrees(scc.comp, scc.groups, scc.adj);
    expect(Array.from(indeg).reduce((a, b) => a + b, 0)).toBe(1);
    const ranked = rankCandidates(candidates, { constraints: defs });
    expect(ranked.map((r) => r.document.id)).toEqual(["c", "a", "b", "f", "d", "e"]);
    expect(ranked[0].constraintMeta.cycles).toEqual([
      ["b", "c", "a"],
      ["e", "f", "d"],
    ]);
    const fromGraph = diagnoseConstraintGraph(graph, candidates, { cycles: scc.cycles });
    expect(fromGraph).toEqual(detectConstraintCycles(candidates, defs));
    expect(fromGraph).toEqual(diagnoseConstraintGraph(graph, candidates));
  });

  test("standalone detectConstraintCycles still computes SCC itself", () => {
    const defs = [{ id: "cycle", invariant: "test", class: "strong", fn: cycleAmong(["a", "b", "c"]) }];
    const candidates = [hit("b", { queryCoverage: 0.2 }), hit("c", { queryCoverage: 0.9 }), hit("a", { queryCoverage: 0.5 })];
    const diagnosis = detectConstraintCycles(candidates, defs);
    expect(diagnosis.cycles).toEqual([["b", "c", "a"]]);
    const ranked = rankCandidates(candidates, { constraints: defs });
    expect(ranked[0].document.id).toBe("c");
    expect(ranked[0].constraintMeta.cycles).toEqual(diagnosis.cycles);
  });

  test("sync and async ranking remain equal on a cyclic graph", async () => {
    const defs = [{ id: "cycle", invariant: "test", class: "strong", fn: cycleAmong(["a", "b", "c"]) }];
    const candidates = [hit("b"), hit("c", { queryCoverage: 0.9 }), hit("a")];
    const sync = rankCandidates(candidates, { constraints: defs });
    const asyncd = await rankCandidatesAsync(candidates, { constraints: defs });
    expect(asyncd.map((r) => ({ id: r.document.id, rank: r.rank, score: r.score }))).toEqual(
      sync.map((r) => ({ id: r.document.id, rank: r.rank, score: r.score }))
    );
    expect(asyncd.map((r) => r.constraintMeta)).toEqual(sync.map((r) => r.constraintMeta));
  });

  test("ranking still polls abort immediately before diagnosis", () => {
    const featured = [hit("b"), hit("a")];
    try {
      rankCandidates(featured, { signal: abortAfter(3) });
      throw new Error("expected AbortError");
    } catch (err) {
      expect(isAbortError(err)).toBe(true);
    }
    const ranked = rankCandidates(featured, { signal: abortAfter(4) });
    expect(ranked.map((r) => r.document.id)).toEqual(["a", "b"]);
  });
});
