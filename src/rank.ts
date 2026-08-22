/**
 * Rank by constraint partial order:
 *   builtin: signature buckets → bucket constraint DAG → SCC → heap frontier
 *   custom: all-pairs graph → SCCs → heap extraction of ready components
 *   → score + stable id inside unordered components / cycle blocks.
 * Cycles/conflicts are attached for explain/tests; they never fail silently.
 *
 * Interpretable within-constraint score is used only inside unordered
 * components of the constraint partial order.
 */

import {
  compareConstraint,
  buildConstraintGraph,
  buildConstraintGraphAsync,
  stronglyConnectedComponents,
  diagnoseConstraintGraph,
  computeComponentIndegrees,
  forEachOutgoingComponent,
  advanceConstraintStamp,
  DEFAULT_CONSTRAINTS,
} from "./constraints.js";
import { throwIfAborted } from "./cancel.js";
import { BinaryMaxHeap, scoreThenIdBetter } from "./rankHeap.js";
import { constraintsAreBuiltin, rankSparse, rankSparseAsync, type RankerStats } from "./rankSparse.js";
import type { ConstraintDef, ConstraintGraph, FeaturedHit, FeatureVector, RankedHit } from "./types.js";

let lastStats: RankerStats | null = null;

/** Last rankCandidates / rankCandidatesAsync instrumentation. Not a public API. */
export function lastRankStats(): RankerStats | null {
  return lastStats;
}

function recordPairwiseStats(C: number, edgeCount: number) {
  lastStats = {
    mode: "pairwise",
    C,
    B: C,
    kAmbiguous: C,
    bucketCompares: 0,
    candidatePairCompares: C <= 1 ? 0 : (C * (C - 1)) / 2,
    bucketEdges: edgeCount,
  };
}

function boolNum(v: unknown) {
  return v ? 1 : 0;
}

function versionNum(v: unknown) {
  if (v === "dotted" || v === "compact-dotted") return 1;
  if (v === "compact-weak" || v === "dotted-weak") return 0.35;
  return 0;
}

function equivNum(v: unknown) {
  if (v === "key-in-title") return 1;
  if (v === "expansion") return 0.8;
  return 0;
}

/**
 * Interpretable within-constraint score. Used only inside unordered
 * components of the constraint partial order.
 */
export function scoreFeatures(f: Partial<FeatureVector>) {
  return (
    boolNum(f.exactTitleMatch) * 5 +
    boolNum(f.exactTitleTokenMatch) * 1.6 +
    (f.queryCoverage || 0) * 2.4 +
    (f.titleCoverage || 0) * 1.2 +
    (f.titlePrefixQuality || 0) * 1.8 +
    equivNum(f.configuredEquivalenceMatch) * 1.5 +
    boolNum(f.canonicalKeyTitle) * 1.3 +
    (f.expansionEvidence || 0) * 0.8 +
    boolNum(f.morphologyMatch) * 0.4 +
    Math.min(f.typoDistance || 0, 2) * 0.35 +
    versionNum(f.versionMatch) * 2.2 +
    boolNum(f.shortLiteralLeadMatch) * 1.7 +
    boolNum(f.dottedSpanComponentTitleMatch) * 0.9 +
    (f.phraseAdjacency || 0) * 0.8 +
    (f.bodyLexicalMatch || 0) * 0.25 +
    (f.relationshipStrength || 0) * 0.45 +
    (f.retrievalScore || 0)
  );
}

function idCmp(a: FeaturedHit, b: FeaturedHit) {
  if (a.document.id < b.document.id) return -1;
  if (a.document.id > b.document.id) return 1;
  return 0;
}

export function compareCandidates(a: FeaturedHit, b: FeaturedHit, defs: ConstraintDef[] = DEFAULT_CONSTRAINTS) {
  const constrained = compareConstraint(a, b, defs);
  if (constrained.order !== 0) return constrained.order;
  if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
  return idCmp(a, b);
}

export function rankCandidates(
  candidates: FeaturedHit[],
  { constraints = DEFAULT_CONSTRAINTS, signal }: { constraints?: ConstraintDef[]; signal?: AbortSignal } = {}
): RankedHit[] {
  throwIfAborted(signal);
  const decorated = candidates.map((c) => ({
    ...c,
    score: Number(scoreFeatures(c.features).toFixed(6)),
  }));
  if (constraintsAreBuiltin(constraints)) {
    return rankSparse(decorated, constraints, { signal, onStats: (s) => (lastStats = s) });
  }
  const graph = buildConstraintGraph(decorated, constraints, { signal });
  recordPairwiseStats(decorated.length, graph.edges.length);
  return orderFromGraph(decorated, graph, constraints, { signal });
}

export async function rankCandidatesAsync(
  candidates: FeaturedHit[],
  { constraints = DEFAULT_CONSTRAINTS, signal }: { constraints?: ConstraintDef[]; signal?: AbortSignal } = {}
): Promise<RankedHit[]> {
  throwIfAborted(signal);
  await Promise.resolve();
  throwIfAborted(signal);
  const decorated = candidates.map((c) => ({
    ...c,
    score: Number(scoreFeatures(c.features).toFixed(6)),
  }));
  if (constraintsAreBuiltin(constraints)) {
    return rankSparseAsync(decorated, constraints, { signal, onStats: (s) => (lastStats = s) });
  }
  const graph = await buildConstraintGraphAsync(decorated, constraints, { signal });
  recordPairwiseStats(decorated.length, graph.edges.length);
  return orderFromGraph(decorated, graph, constraints, { signal });
}

function orderComponents(decorated: FeaturedHit[], graph: ConstraintGraph) {
  const { n, edges } = graph;
  const { comp, groups, cycles, adj } = stronglyConnectedComponents(n, edges);

  const nComp = groups.length;
  const indeg = computeComponentIndegrees(comp, groups, adj);
  const marks = new Uint32Array(nComp);
  let generation = 0;

  const bestScore = new Float64Array(nComp);
  const bestId: string[] = new Array(nComp);
  for (let g = 0; g < nComp; g++) {
    let best = decorated[groups[g][0]];
    for (let k = 1; k < groups[g].length; k++) {
      const cand = decorated[groups[g][k]];
      if (scoreThenIdBetter(cand.score || 0, cand.document.id, best.score || 0, best.document.id)) best = cand;
    }
    bestScore[g] = best.score || 0;
    bestId[g] = best.document.id;
  }

  const heap = new BinaryMaxHeap<number>((ga, gb) =>
    scoreThenIdBetter(bestScore[ga], bestId[ga], bestScore[gb], bestId[gb])
  );
  for (let g = 0; g < nComp; g++) if (indeg[g] === 0) heap.push(g);

  const topo: number[] = [];
  while (heap.size) {
    const g = heap.pop();
    topo.push(g);
    generation = advanceConstraintStamp(marks, generation);
    forEachOutgoingComponent(g, comp, groups, adj, marks, generation, (h) => {
      indeg[h] -= 1;
      if (indeg[h] === 0) heap.push(h);
    });
  }
  if (topo.length < groups.length) {
    for (let g = 0; g < groups.length; g++) if (!topo.includes(g)) topo.push(g);
  }

  const ordered: FeaturedHit[] = [];
  for (const g of topo) {
    const members = groups[g].map((i) => decorated[i]);
    members.sort((a, b) => {
      if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
      return idCmp(a, b);
    });
    ordered.push(...members);
  }
  // Reverse CSR was never stored on the SCC result. Forward CSR / groups /
  // comp become unreachable when this frame returns; diagnosis keeps only
  // the copied `cycles` rows.
  return { ordered, cycles };
}

function orderFromGraph(
  decorated: FeaturedHit[],
  graph: ConstraintGraph,
  constraints: ConstraintDef[],
  { signal }: { signal?: AbortSignal } = {}
): RankedHit[] {
  throwIfAborted(signal);
  const { ordered, cycles } = orderComponents(decorated, graph);

  // Same abort opportunity the previous second buildConstraintGraph() polled
  // at its first pair (k === 0) before diagnostic work.
  throwIfAborted(signal);
  const diagnosis = diagnoseConstraintGraph(graph, decorated, { cycles });

  return ordered.map((c, i) => ({
    ...c,
    score: c.score ?? 0,
    rank: i + 1,
    constraintVsNext:
      i + 1 < ordered.length
        ? compareConstraint(c, ordered[i + 1], constraints)
        : { order: 0, applied: [], conflict: false, resolution: "unordered" },
    constraintMeta: {
      cycles: diagnosis.cycles,
      conflictCount: diagnosis.conflicts.length,
    },
  }));
}

export { detectConstraintCycles } from "./constraints.js";
export { compareConstraint };
